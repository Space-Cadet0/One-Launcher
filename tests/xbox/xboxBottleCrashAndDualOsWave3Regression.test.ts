import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

import {
  buildXboxBridge,
  binaryAndManifestInspectors,
  wineAndCrossOverManager,
  xboxTitleStorageSync,
  xboxRuntimeLoopbackServer,
  buildValidMinimalPe64Buffer,
} from '../helpers/xboxTestHarness';

const nodeRequire = createRequire(import.meta.url);
const afterPack = nodeRequire('../../build/afterPack.cjs');
const firstPartyRegistration = nodeRequire('../../electron/launcher/firstPartyRegistration.cjs');
const xboxConfigAndIds = nodeRequire('../../electron/storefronts/xbox/xboxConfigAndIds.cjs');
const windowsXboxOrchestrator = nodeRequire(
  '../../electron/launcher/windowsXboxAppxAndMsixvcOrchestrator.cjs'
);
const sessionAndProcessSupervisor = nodeRequire(
  '../../electron/launcher/sessionAndProcessSupervisor.cjs'
);
const engineStateRegistry = nodeRequire('../../electron/launcher/engineStateRegistry.cjs');

// ============================================================================
// Hermetic Offline Socket Guard (permits 127.0.0.1 / ::1 loopback RPC only)
// ============================================================================

function installHermeticOfflineSocketGuard() {
  const origConnect = net.Socket.prototype.connect;
  return vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: any[]
  ) {
    const first = args[0];
    const host =
      typeof first === 'object' && first !== null && 'host' in first
        ? String((first as { host?: string }).host || '127.0.0.1')
        : typeof args[1] === 'string'
          ? args[1]
          : '127.0.0.1';
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const isUnixPipe =
      typeof first === 'string' || (typeof first === 'object' && first !== null && 'path' in first);
    if (!isLoopback && !isUnixPipe) {
      throw new Error(`Hermetic test guard blocked outbound TCP connection to "${host}"`);
    }
    return (origConnect as any).apply(this, args);
  });
}

// ============================================================================
// Synthetic PE Machine Header & RPC Client Helpers
// ============================================================================

function buildPeBufferWithMachine(machine: number, marker = 'SYNTHETIC-PE'): Buffer {
  const markerBytes = Buffer.from(marker, 'utf8');
  const buf = Buffer.alloc(Math.max(256, 0x90 + markerBytes.length), 0);
  buf[0] = 0x4d; // 'M'
  buf[1] = 0x5a; // 'Z'
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
  buf[0x80] = 0x50; // 'P'
  buf[0x81] = 0x45; // 'E'
  buf[0x82] = 0x00;
  buf[0x83] = 0x00;
  buf.writeUInt16LE(machine & 0xffff, 0x84);
  markerBytes.copy(buf, 0x90);
  return buf;
}

class MockChildProcess extends EventEmitter {
  pid: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  constructor(pid = 42420) {
    super();
    this.pid = pid;
  }

  kill() {
    this.killed = true;
    this.emit('exit', 0, null);
    this.emit('close', 0, null);
    return true;
  }

  unref() {}
}

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
        const head = Buffer.concat(chunks, total);
        expectedBody = head.readUInt32LE(0);
      }
      if (expectedBody >= 0 && total >= 4 + expectedBody) {
        const full = Buffer.concat(chunks, total);
        const jsonText = full.subarray(4, 4 + expectedBody).toString('utf8');
        sock.end();
        try {
          resolve(JSON.parse(jsonText));
        } catch (err) {
          reject(err);
        }
      }
    });

    sock.on('error', reject);
  });
}

// ============================================================================
// Wave 3 Hermetic Regression Suite: Bottled Xbox Crash Fixes & Dual-OS Parity
// ============================================================================

describe('Wave 3 Bottled Xbox Crash Fixes & Dual-OS Regression Suite', () => {
  const tempDirs: string[] = [];
  let socketGuard: ReturnType<typeof installHermeticOfflineSocketGuard>;

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ol-wave3-${prefix}-`));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    socketGuard = installHermeticOfflineSocketGuard();
  });

  afterEach(async () => {
    const activeMap = engineStateRegistry.activeSessions as Map<string, any>;
    for (const [gameId] of Array.from(activeMap.entries())) {
      const entry = activeMap.get(gameId);
      if (entry?.pollTimer) clearInterval(entry.pollTimer);
      if (entry?.xboxLoopbackServer?.close) {
        await entry.xboxLoopbackServer.close().catch(() => {});
      }
      activeMap.delete(gameId);
    }
    await sessionAndProcessSupervisor.waitForActivePostSessionWork(2000).catch(() => {});
    socketGuard.mockRestore();
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe('1. PE64 Artifacts Verification, CheckSum Integrity & afterPack Cross-OS Pruning', () => {
    it('blocks non-loopback outbound TCP connections via the hermetic socket guard', () => {
      const sock = new net.Socket();
      expect(() => sock.connect(443, 'example.com')).toThrow(/Hermetic test guard blocked/);
      sock.destroy();
    });

    it('verifies all 4 compiled PE32+ (0x8664) Xbox bridge & launcher binaries, exports, markers, and PE OptionalHeader.CheckSum', () => {
      const xgrInfo = buildXboxBridge.verifyXboxBridgeDll();
      const giInfo = buildXboxBridge.verifyGameInputBridgeDll();
      const appNotifyInfo = buildXboxBridge.verifyAppNotifyBridgeDll();
      const winLauncherInfo = buildXboxBridge.verifyWinXgrLauncherExe();
      const manifest = buildXboxBridge.verifyBridgeBuildManifest({
        xgrInfo,
        giInfo,
        appNotifyInfo,
        winLauncherInfo,
      });

      expect(xgrInfo.machine).toBe('0x8664');
      expect(xgrInfo.exports).toEqual(
        expect.arrayContaining([
          'DllCanUnloadNow',
          'InitializeApiImpl',
          'InitializeApiImplEx',
          'InitializeApiImplEx2',
          'QueryApiImpl',
          'UninitializeApiImpl',
          'XErrorReport',
        ])
      );

      expect(giInfo.machine).toBe('0x8664');
      expect(giInfo.exports).toEqual(expect.arrayContaining(['DllCanUnloadNow', 'GameInputCreate']));

      expect(appNotifyInfo.machine).toBe('0x8664');
      expect(appNotifyInfo.exports).toEqual(
        expect.arrayContaining([
          'RegisterAppStateChangeNotification',
          'UnregisterAppStateChangeNotification',
          'RegisterAppConstrainedChangeNotification',
          'UnregisterAppConstrainedChangeNotification',
        ])
      );

      expect(winLauncherInfo.machine).toBe('0x8664');
      expect(winLauncherInfo.subsystem).toBe(2);
      expect(manifest.schemaVersion).toBe(1);

      const artifactChecks = [
        { path: buildXboxBridge.DLL_PATH, marker: 'OneLauncher.XGRBridge.v1' },
        { path: buildXboxBridge.GAMEINPUT_DLL_PATH, marker: 'OneLauncher.GameInputBridge.v1' },
        { path: buildXboxBridge.APPNOTIFY_DLL_PATH, marker: 'OneLauncher.AppNotifyBridge.v1' },
        { path: buildXboxBridge.WIN_LAUNCHER_EXE_PATH, marker: 'OneLauncher.XGRWinLauncher.v1' },
      ];

      for (const art of artifactChecks) {
        const buf = fs.readFileSync(art.path);
        expect(buf.includes(Buffer.from(art.marker, 'utf8'))).toBe(true);
        const peOffset = buf.readUInt32LE(0x3c);
        const optOffset = peOffset + 24;
        expect(buf.readUInt16LE(optOffset)).toBe(0x020b); // PE32+
        const checkSumOffset = optOffset + 64;
        const storedCheckSum = buf.readUInt32LE(checkSumOffset);
        const expectedCheckSum = buildXboxBridge.computePeCheckSum(buf, checkSumOffset);
        expect(storedCheckSum).toBe(expectedCheckSum);
        expect(storedCheckSum).toBeGreaterThan(0);
      }
    });

    it('preserves all 3 CrossOver bridge DLLs and prunes one_xgr_win_launcher.exe on darwin, while retaining all 4 on win32', () => {
      const populateFakeUnpackedTree = (rootDir: string) => {
        const helpersDir = path.join(rootDir, 'electron', 'helpers');
        const helpersBinDir = path.join(helpersDir, 'bin');
        const cliDarwinDir = path.join(rootDir, 'electron', 'bin', 'legendary', 'darwin');
        const cliWinDir = path.join(rootDir, 'electron', 'bin', 'legendary', 'win32');
        const assetsDir = path.join(rootDir, 'electron', 'assets');

        fs.mkdirSync(helpersBinDir, { recursive: true });
        fs.mkdirSync(cliDarwinDir, { recursive: true });
        fs.mkdirSync(cliWinDir, { recursive: true });
        fs.mkdirSync(assetsDir, { recursive: true });

        fs.writeFileSync(path.join(helpersBinDir, 'one_xgameruntime_bridge.dll'), 'MZ-xgr');
        fs.writeFileSync(path.join(helpersBinDir, 'one_gameinput_bridge.dll'), 'MZ-gi');
        fs.writeFileSync(path.join(helpersBinDir, 'one_appnotify_bridge.dll'), 'MZ-appnotify');
        fs.writeFileSync(path.join(helpersBinDir, 'one_xgr_win_launcher.exe'), 'MZ-winlauncher');
        fs.writeFileSync(path.join(helpersDir, 'libone_metal_preload.dylib'), 'MACHO-dylib');
        fs.writeFileSync(path.join(cliDarwinDir, 'legendary'), 'MACHO-cli');
        fs.writeFileSync(path.join(cliWinDir, 'legendary.exe'), 'MZ-cli');
        fs.writeFileSync(path.join(assetsDir, 'tray.icns'), 'icns');
        fs.writeFileSync(path.join(assetsDir, 'tray.ico'), 'ico');

        return { helpersBinDir, helpersDir, cliDarwinDir, cliWinDir, assetsDir };
      };

      // macOS (darwin) packaging prune
      const macUnpacked = makeTempDir('afterpack-darwin');
      const macPaths = populateFakeUnpackedTree(macUnpacked);
      afterPack._testHelpers.pruneUnpackedCrossOsAssets(macUnpacked, 'darwin');

      expect(fs.existsSync(path.join(macPaths.helpersBinDir, 'one_xgameruntime_bridge.dll'))).toBe(true);
      expect(fs.existsSync(path.join(macPaths.helpersBinDir, 'one_gameinput_bridge.dll'))).toBe(true);
      expect(fs.existsSync(path.join(macPaths.helpersBinDir, 'one_appnotify_bridge.dll'))).toBe(true);
      expect(fs.existsSync(path.join(macPaths.helpersBinDir, 'one_xgr_win_launcher.exe'))).toBe(false);
      expect(fs.existsSync(path.join(macPaths.helpersDir, 'libone_metal_preload.dylib'))).toBe(true);
      expect(fs.existsSync(macPaths.cliWinDir)).toBe(false);
      expect(fs.existsSync(path.join(macPaths.assetsDir, 'tray.ico'))).toBe(false);

      // Windows (win32) packaging prune
      const winUnpacked = makeTempDir('afterpack-win32');
      const winPaths = populateFakeUnpackedTree(winUnpacked);
      afterPack._testHelpers.pruneUnpackedCrossOsAssets(winUnpacked, 'win32');

      expect(fs.existsSync(path.join(winPaths.helpersBinDir, 'one_xgameruntime_bridge.dll'))).toBe(true);
      expect(fs.existsSync(path.join(winPaths.helpersBinDir, 'one_gameinput_bridge.dll'))).toBe(true);
      expect(fs.existsSync(path.join(winPaths.helpersBinDir, 'one_appnotify_bridge.dll'))).toBe(true);
      expect(fs.existsSync(path.join(winPaths.helpersBinDir, 'one_xgr_win_launcher.exe'))).toBe(true);
      expect(fs.existsSync(path.join(winPaths.helpersDir, 'libone_metal_preload.dylib'))).toBe(false);
      expect(fs.existsSync(winPaths.cliDarwinDir)).toBe(false);
      expect(fs.existsSync(path.join(winPaths.assetsDir, 'tray.icns'))).toBe(false);
    });
  });

  describe('2. Wine Registry REG_QWORD, prepareXboxBottleEnvironment & Depth-8 DLL Discovery', () => {
    it('formats REG_QWORD values as little-endian hex(b) bytes in formatWineRegEntryLine', () => {
      const qwordVersion = 0x0026007569790000n; // 38.117.27001.0
      expect(
        firstPartyRegistration.formatWineRegEntryLine('CurrentVersion', {
          type: 'qword',
          value: qwordVersion,
        })
      ).toBe('"CurrentVersion"=hex(b):00,00,79,69,75,00,26,00');

      expect(
        firstPartyRegistration.formatWineRegEntryLine('AvailableVersion', 'REG_QWORD', qwordVersion)
      ).toBe('"AvailableVersion"=hex(b):00,00,79,69,75,00,26,00');

      expect(
        firstPartyRegistration.formatWineRegEntryLine('Preformatted', {
          type: 'qword',
          value: 'HEX(B):00,00,79,69,75,00,26,00',
        })
      ).toBe('"Preformatted"=hex(b):00,00,79,69,75,00,26,00');
    });

    it('finds deeply nested executables up to default maxDepth=8 via findFilesMatching', async () => {
      const rootDir = makeTempDir('depth8');
      const depth6ExeDir = path.join(rootDir, 'Content', 'A', 'B', 'C', 'D', 'E');
      const depth8ExeDir = path.join(depth6ExeDir, 'F', 'G');
      const depth9ExeDir = path.join(depth8ExeDir, 'H', 'I');
      fs.mkdirSync(depth9ExeDir, { recursive: true });

      const gameDepth6 = path.join(depth6ExeDir, 'Game.exe');
      const gameDepth8 = path.join(depth8ExeDir, 'DeepPlugin.dll');
      const gameDepth10 = path.join(depth9ExeDir, 'TooDeep.dll');
      fs.writeFileSync(gameDepth6, buildValidMinimalPe64Buffer('DEPTH-6'));
      fs.writeFileSync(gameDepth8, buildValidMinimalPe64Buffer('DEPTH-8'));
      fs.writeFileSync(gameDepth10, buildValidMinimalPe64Buffer('DEPTH-10'));

      const foundDefault = await wineAndCrossOverManager.findFilesMatching(
        rootDir,
        (_fullPath: string, name: string) => /\.(exe|dll)$/i.test(name)
      );
      expect(foundDefault).toContain(gameDepth6);
      expect(foundDefault).toContain(gameDepth8);
      expect(foundDefault).not.toContain(gameDepth10);
    });

    it('stages system32 & deep local appnotify/xgameruntime/gameinput bridges, VCLibs *_app.dll, REG_QWORD GamingServices, and DllOverrides in prepareXboxBottleEnvironment', async () => {
      const bottleDir = makeTempDir('bottle');
      const system32Dir = path.join(bottleDir, 'drive_c', 'windows', 'system32');
      const userLocalDir = path.join(
        bottleDir,
        'drive_c',
        'users',
        'crossover',
        'AppData',
        'Local'
      );
      fs.mkdirSync(system32Dir, { recursive: true });
      fs.mkdirSync(userLocalDir, { recursive: true });

      const installDir = makeTempDir('ue-wingdk');
      const deepExeDir = path.join(
        installDir,
        'Content',
        'Project',
        'Binaries',
        'WinGDK',
        'SubA',
        'SubB'
      );
      const vcLibsDir = path.join(installDir, 'FrameworkPackages', 'VCLibs_x64');
      fs.mkdirSync(deepExeDir, { recursive: true });
      fs.mkdirSync(vcLibsDir, { recursive: true });

      const exePath = path.join(deepExeDir, 'ShippingGame-WinGDK-Shipping.exe');
      fs.writeFileSync(exePath, buildValidMinimalPe64Buffer('SHIPPING-EXE'));

      // Stage synthetic retail Microsoft DLLs at depth 6 to verify .msft.bak backup + replacement
      const retailXgrPath = path.join(deepExeDir, 'Xgameruntime.dll');
      const retailGiPath = path.join(deepExeDir, 'GameInputRedist.dll');
      const retailAppNotifyPath = path.join(
        deepExeDir,
        'api-ms-win-core-psm-appnotify-l1-1-0.dll'
      );
      fs.writeFileSync(retailXgrPath, buildValidMinimalPe64Buffer('MSFT-RETAIL-XGR'));
      fs.writeFileSync(retailGiPath, buildValidMinimalPe64Buffer('MSFT-RETAIL-GI'));
      fs.writeFileSync(retailAppNotifyPath, buildValidMinimalPe64Buffer('MSFT-RETAIL-APPNOTIFY'));

      // Donor CRT DLLs in Wine x86_64-windows lib dir (simulating CrossOver donor CRT libraries)
      const fakeCompatRoot = makeTempDir('fake-crossover');
      const fakeWineBinDir = path.join(fakeCompatRoot, 'bin');
      const fakeWineWin64LibDir = path.join(fakeCompatRoot, 'lib', 'wine', 'x86_64-windows');
      fs.mkdirSync(fakeWineBinDir, { recursive: true });
      fs.mkdirSync(fakeWineWin64LibDir, { recursive: true });
      const fakeWineBin = path.join(fakeWineBinDir, 'wine');
      fs.writeFileSync(fakeWineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      for (const vcDll of [
        'vcruntime140.dll',
        'vcruntime140_1.dll',
        'msvcp140.dll',
        'concrt140.dll',
        'vccorlib140.dll',
      ]) {
        fs.writeFileSync(
          path.join(fakeWineWin64LibDir, vcDll),
          buildValidMinimalPe64Buffer(`DONOR-${vcDll}`)
        );
      }

      const env: Record<string, string> = {};
      const prep = await wineAndCrossOverManager.prepareXboxBottleEnvironment({
        bottlePath: bottleDir,
        compatLayer: { type: 'crossover', binaryPath: fakeWineBin },
        installDir,
        executablePath: exePath,
        packageFamilyName: 'Studio.ShippingGame_8wekyb3d8bbwe',
        xuid: '2533274790395904',
        scid: '00000000-0000-0000-0000-000071b6a9d4',
        env,
        skipLiveWineRegSync: true,
      });

      expect(prep.provisioned).toBe(true);
      expect(prep.bridgeStaged).toBe(true);
      expect(prep.gameInputStaged).toBe(true);
      expect(prep.appNotifyStaged).toBe(true);

      // Verify system32 staging of all bridges including api-ms-win-core-psm-appnotify-l1-1-0.dll
      const sys32AppNotify = path.join(system32Dir, 'api-ms-win-core-psm-appnotify-l1-1-0.dll');
      expect(fs.existsSync(sys32AppNotify)).toBe(true);
      expect(
        fs
          .readFileSync(sys32AppNotify)
          .includes(Buffer.from('OneLauncher.AppNotifyBridge.v1', 'utf8'))
      ).toBe(true);

      // Verify deep local DLL overrides & .msft.bak preservation
      expect(fs.existsSync(`${retailXgrPath}.msft.bak`)).toBe(true);
      expect(fs.existsSync(`${retailGiPath}.msft.bak`)).toBe(true);
      expect(fs.existsSync(`${retailAppNotifyPath}.msft.bak`)).toBe(true);
      expect(
        fs.readFileSync(retailAppNotifyPath).includes(
          Buffer.from('OneLauncher.AppNotifyBridge.v1', 'utf8')
        )
      ).toBe(true);

      // Verify VCLibs *_app.dll synthesis into bottle system32 from Wine x86_64-windows donor DLLs
      for (const appDll of [
        'vcruntime140_app.dll',
        'vcruntime140_1_app.dll',
        'msvcp140_app.dll',
        'concrt140_app.dll',
        'vccorlib140_app.dll',
      ]) {
        expect(fs.existsSync(path.join(system32Dir, appDll))).toBe(true);
      }

      // Verify system.reg REG_QWORD CurrentVersion & AvailableVersion in 64-bit & Wow6432Node keys
      const systemRegText = fs.readFileSync(path.join(bottleDir, 'system.reg'), 'utf8');
      expect(systemRegText).toContain('[Software\\\\Microsoft\\\\GamingServices]');
      expect(systemRegText).toContain('[Software\\\\Wow6432Node\\\\Microsoft\\\\GamingServices]');
      const qwordMatches = systemRegText.match(
        /"(?:CurrentVersion|AvailableVersion)"=hex\(b\):00,00,79,69,75,00,26,00/g
      );
      expect(qwordMatches?.length).toBeGreaterThanOrEqual(4);

      // Verify user.reg Software\Wine\DllOverrides & env.WINEDLLOVERRIDES
      const userRegText = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(userRegText).toContain('[Software\\\\Wine\\\\DllOverrides]');
      expect(userRegText).toContain('"api-ms-win-core-psm-appnotify-l1-1-0"="native,builtin"');
      expect(userRegText).toContain('"concrt140"="native,builtin"');
      expect(env.WINEDLLOVERRIDES).toContain('api-ms-win-core-psm-appnotify-l1-1-0=n,b');
      expect(env.WINEDLLOVERRIDES).toContain('concrt140=n,b');
    });
  });

  describe('3. MicrosoftGame.config <DevelopmentOnly> Stripping & SCID Reconciliation', () => {
    it('strips <DevelopmentOnly> blocks and reconciles <TitleId> against mismatched dev Scid while exposing fallbackScid', () => {
      const xmlWithDevMismatch = `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <DevelopmentOnly>
    <Identity Name="DevSandbox.WrongIdentity" Publisher="CN=00000000-0000-0000-0000-000000000000" Version="0.0.1.0"/>
    <TitleId>DEADBEEF</TitleId>
    <ExecutableList>
      <Executable Name="DevSandboxCrash.exe" Id="Dev"/>
    </ExecutableList>
    <ExtendedAttributeList>
      <ExtendedAttribute Name="Scid" Value="00000000-0000-0000-0000-0000deadbeef"/>
    </ExtendedAttributeList>
  </DevelopmentOnly>
  <Identity Name="RetailStudio.RealGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.4.2.0"/>
  <TitleId>71B6A9D4</TitleId>
  <MSAAppId>000000004899ABCD</MSAAppId>
  <StoreId>9P1234567890</StoreId>
  <ExecutableList>
    <Executable Name="Binaries\\WinGDK\\RealGame.exe" Id="Game"/>
  </ExecutableList>
  <ExtendedAttributeList>
    <ExtendedAttribute Name="Scid" Value="00000000-0000-0000-0000-0000790907e2"/>
  </ExtendedAttributeList>
</Game>`;

      const parsed = xboxConfigAndIds.parseMicrosoftGameConfigXml(xmlWithDevMismatch);
      expect(parsed.identity.name).toBe('RetailStudio.RealGame');
      expect(parsed.titleId).toBe('71B6A9D4');
      expect(parsed.primaryExecutable).toBe('Binaries/WinGDK/RealGame.exe');
      expect(parsed.scid).toBe('00000000-0000-0000-0000-000071b6a9d4');
      expect(parsed.fallbackScid).toBe('00000000-0000-0000-0000-0000790907e2');

      const inspected = binaryAndManifestInspectors.inspectMicrosoftGameConfig(xmlWithDevMismatch);
      expect(inspected.identityName).toBe('RetailStudio.RealGame');
      expect(inspected.scid).toBe('00000000-0000-0000-0000-000071b6a9d4');
      expect(inspected.fallbackScid).toBe('00000000-0000-0000-0000-0000790907e2');
    });

    it('preserves non-zero-prefixed custom XDP UUID SCIDs as primary scid and derives <TitleId> SCID as fallbackScid', () => {
      const customXdpXml = `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="XdpStudio.LegacyTitle" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="2.0.0.0"/>
  <TitleId>71B6A9D4</TitleId>
  <ExecutableList>
    <Executable Name="LegacyTitle.exe" Id="Game"/>
  </ExecutableList>
  <ExtendedAttributeList>
    <ExtendedAttribute Name="Scid" Value="a1b2c3d4-e5f6-4789-abcd-ef0123456789"/>
  </ExtendedAttributeList>
</Game>`;

      const parsed = xboxConfigAndIds.parseMicrosoftGameConfigXml(customXdpXml);
      expect(parsed.scid).toBe('a1b2c3d4-e5f6-4789-abcd-ef0123456789');
      expect(parsed.fallbackScid).toBe('00000000-0000-0000-0000-000071b6a9d4');
    });
  });

  describe('4. Title Storage Path Encoding, HTTP 403/404 Fallback SCID Sync & Loopback Active SCID Tracking', () => {
    it('preserves literal "/" in hierarchical container paths and rejects traversal, control chars, and invalid prefixes', () => {
      expect(xboxTitleStorageSync.encodeTitleStorageContainerPath('Slot_01/SaveData')).toBe(
        'Slot_01/SaveData'
      );
      expect(
        xboxTitleStorageSync.encodeTitleStorageContainerPath('Profile_Main/Settings/Graphics.bin')
      ).toBe('Profile_Main/Settings/Graphics.bin');
      expect(xboxTitleStorageSync.encodeTitleStorageContainerPath('Slot_01\\Save+1')).toBe(
        'Slot_01/Save%2B1'
      );

      expect(() =>
        xboxTitleStorageSync.encodeTitleStorageContainerPath('Slot_01/../Secret')
      ).toThrow(/Invalid TitleStorage container name/);
      expect(() =>
        xboxTitleStorageSync.encodeTitleStorageContainerPath('Slot_01/Bad\x00Char')
      ).toThrow(/Invalid TitleStorage container name/);
      expect(() =>
        xboxTitleStorageSync.encodeTitleStorageContainerPath('Slot-With-Hyphen/SaveData')
      ).toThrow(/Invalid TitleStorage container name/);
      expect(() =>
        xboxTitleStorageSync.encodeTitleStorageContainerPath(
          '0009000000000001_00000000-0000-0000-0000-000071b6a9d4/Save1'
        )
      ).toThrow(/Invalid TitleStorage container name/);
    });

    it('retries syncXboxTitleStorage on HTTP 403/404 using fallbackScid with both preserveLocalWgsDirOnFallback:true and default folder switch', async () => {
      const xuid = '2533274790395904';
      const primaryScid = '00000000-0000-0000-0000-0000790907e2';
      const fallbackScid = '00000000-0000-0000-0000-000071b6a9d4';
      const atomUuid = '11111111-2222-3333-4444-555555555555';
      const cloudSaveBytes = Buffer.from('HYDRATED-FALLBACK-CLOUD-SAVE', 'utf8');

      const buildMockTitleStorageFetch = (failStatus: 403 | 404) => {
        const requestedUrls: string[] = [];
        const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
          const urlStr = String(input);
          const method = String(init?.method || 'GET').toUpperCase();
          requestedUrls.push(`${method} ${urlStr}`);

          if (urlStr.includes(primaryScid)) {
            const errBody = JSON.stringify({ code: 1001, description: 'Invalid SCID for title' });
            return {
              ok: false,
              status: failStatus,
              headers: new Headers({ 'content-type': 'application/json' }),
              arrayBuffer: async () => Buffer.from(errBody, 'utf8'),
            };
          }

          if (urlStr.includes('/lock')) {
            if (method === 'DELETE') {
              return {
                ok: true,
                status: 200,
                headers: new Headers(),
                arrayBuffer: async () => Buffer.alloc(0),
              };
            }
            const lockBody = JSON.stringify({ quotaInfo: { quotaBytes: 268435456 } });
            return {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-type': 'application/json' }),
              arrayBuffer: async () => Buffer.from(lockBody, 'utf8'),
            };
          }

          if (
            urlStr.endsWith(`/scids/${fallbackScid}`) ||
            urlStr.includes(`/scids/${fallbackScid}?`)
          ) {
            const listBody = JSON.stringify({
              blobs: [
                {
                  fileName: 'Slot_01/SaveData,savedgame',
                  displayName: 'Slot 01',
                  etag: '"etag-1"',
                  clientFileTime: '2026-10-28T12:00:00.000Z',
                  size: cloudSaveBytes.length,
                },
              ],
            });
            return {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-type': 'application/json' }),
              arrayBuffer: async () => Buffer.from(listBody, 'utf8'),
            };
          }

          if (urlStr.includes('/Slot_01/SaveData,savedgame')) {
            const atomsBody = JSON.stringify({
              atoms: { 'profile.sav': `${atomUuid},binary` },
            });
            return {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-type': 'application/json' }),
              arrayBuffer: async () => Buffer.from(atomsBody, 'utf8'),
            };
          }

          if (urlStr.includes(`/${atomUuid},binary`)) {
            return {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-type': 'application/octet-stream' }),
              arrayBuffer: async () => cloudSaveBytes,
            };
          }

          throw new Error(`Unexpected mock TitleStorage request: ${method} ${urlStr}`);
        });
        return { fetchImpl, requestedUrls };
      };

      // Case A: preserveLocalWgsDirOnFallback: true (used by active loopback RPC server)
      const rootPreserve = makeTempDir('wgs-preserve');
      const primaryFolder = xboxTitleStorageSync.formatWgsUserScidFolderName(xuid, primaryScid);
      const fallbackFolder = xboxTitleStorageSync.formatWgsUserScidFolderName(xuid, fallbackScid);
      const wgsPrimaryDirA = path.join(rootPreserve, 'wgs', primaryFolder);
      const xgsPrimaryDirA = path.join(rootPreserve, 'xgs', primaryFolder);

      const mock403 = buildMockTitleStorageFetch(403);
      const resPreserve = await xboxTitleStorageSync.syncXboxTitleStorage({
        mode: 'pre_launch',
        wgsUserDir: wgsPrimaryDirA,
        xgsUserDir: xgsPrimaryDirA,
        xuid,
        scid: primaryScid,
        fallbackScid,
        preserveLocalWgsDirOnFallback: true,
        authorizationHeader: 'XBL3.0 x=2533274790395904;tok',
        fetchImpl: mock403.fetchImpl,
      });

      expect(resPreserve.synced).toBe(true);
      expect(resPreserve.resolvedScid).toBe(fallbackScid);
      expect(resPreserve.resolvedWgsUserDir).toBe(wgsPrimaryDirA);
      expect(resPreserve.downloadedContainers).toBe(1);
      expect(fs.existsSync(path.join(wgsPrimaryDirA, 'containers.index'))).toBe(true);
      expect(
        fs.readFileSync(path.join(xgsPrimaryDirA, 'Slot_01', 'SaveData', 'profile.sav')).toString(
          'utf8'
        )
      ).toBe('HYDRATED-FALLBACK-CLOUD-SAVE');
      // Verify hierarchical "/" was NOT escaped to "%2F" in wire URL
      expect(
        mock403.requestedUrls.some((u) => u.includes('/Slot_01/SaveData,savedgame'))
      ).toBe(true);
      expect(mock403.requestedUrls.some((u) => u.includes('Slot_01%2FSaveData'))).toBe(false);

      // Case B: Default pre_launch behavior (switches local wgsUserDir to <HexXuid>_<fallbackScid>)
      const rootSwitch = makeTempDir('wgs-switch');
      const wgsPrimaryDirB = path.join(rootSwitch, 'wgs', primaryFolder);
      const xgsPrimaryDirB = path.join(rootSwitch, 'xgs', primaryFolder);

      const mock404 = buildMockTitleStorageFetch(404);
      const resSwitch = await xboxTitleStorageSync.syncXboxTitleStorage({
        mode: 'pre_launch',
        wgsUserDir: wgsPrimaryDirB,
        xgsUserDir: xgsPrimaryDirB,
        xuid,
        scid: primaryScid,
        fallbackScid,
        authorizationHeader: 'XBL3.0 x=2533274790395904;tok',
        fetchImpl: mock404.fetchImpl,
      });

      const expectedFallbackWgsDir = path.join(rootSwitch, 'wgs', fallbackFolder);
      expect(resSwitch.synced).toBe(true);
      expect(resSwitch.resolvedScid).toBe(fallbackScid);
      expect(resSwitch.resolvedWgsUserDir).toBe(expectedFallbackWgsDir);
      expect(fs.existsSync(path.join(expectedFallbackWgsDir, 'containers.index'))).toBe(true);
    });

    it('tracks runtime-initialized SCIDs via loopback getActiveScids() and syncs all active SCIDs on finalizeGameSession post_exit', async () => {
      const saveSysDir = makeTempDir('loopback-sysappdata');
      const manifestScid = '00000000-0000-0000-0000-000071b6a9d4';
      const embeddedRuntimeScid = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';

      const server = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
        userProfile: { xuid: '2533274790395904', gamertag: 'Wave3Tester' },
        gameMetadata: {
          titleId: '71B6A9D4',
          scid: manifestScid,
          packageFamilyName: 'Studio.EmbeddedScidGame_8wekyb3d8bbwe',
        },
        saveRootDir: saveSysDir,
        enableCloudSaveSync: false,
      });

      const initResp = await sendLoopbackRpcCall(
        server.port,
        server.sessionKey,
        'xgamesave.init',
        {
          scid: embeddedRuntimeScid,
          packageFamilyName: 'Studio.EmbeddedScidGame_8wekyb3d8bbwe',
        },
        1
      );
      expect(initResp.ok).toBe(true);
      expect(server.getActiveScids()).toEqual([embeddedRuntimeScid]);

      // Write a dirty container under the runtime-selected SCID folder so post_exit uploads it
      const runtimeFolder = xboxTitleStorageSync.formatWgsUserScidFolderName(
        '2533274790395904',
        embeddedRuntimeScid
      );
      const runtimeWgsDir = path.join(saveSysDir, 'wgs', runtimeFolder);
      await xboxTitleStorageSync.writeLocalWgsWorkspace(runtimeWgsDir, {
        containers: [
          {
            name: 'Autosave',
            displayName: 'Autosave',
            dirty: true,
            blobs: [{ name: 'state.bin', data: Buffer.from('POST-EXIT-RUNTIME-SCID-SAVE') }],
          },
        ],
      });

      const uploadedUrls: string[] = [];
      const mockPostExitFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const urlStr = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        uploadedUrls.push(`${method} ${urlStr}`);
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
          arrayBuffer: async () => Buffer.from('{}'),
        };
      });

      const fakeBottleDir = makeTempDir('post-exit-bottle');
      const fakeLocalAppData = path.join(
        fakeBottleDir,
        'drive_c',
        'users',
        'crossover',
        'AppData',
        'Local',
        'Packages',
        'Studio.EmbeddedScidGame_8wekyb3d8bbwe'
      );
      fs.mkdirSync(fakeLocalAppData, { recursive: true });
      fs.cpSync(saveSysDir, path.join(fakeLocalAppData, 'SystemAppData'), { recursive: true });

      const gameId = 'xbox-embedded-scid-post-exit';
      (engineStateRegistry.activeSessions as Map<string, any>).set(gameId, {
        session: {
          sessionId: 'sess-wave3-1',
          gameId,
          platformId: 'xbox',
          platformGameId: '9PEMBEDDED01',
          title: 'Embedded SCID Game',
          status: 'running',
          launchMethod: 'compatibility_layer:crossover',
          startedAt: new Date(Date.now() - 120_000).toISOString(),
        },
        startedMs: Date.now() - 120_000,
        exitCode: 0,
        stoppedByUser: false,
        winePrefix: fakeBottleDir,
        packageFamilyName: 'Studio.EmbeddedScidGame_8wekyb3d8bbwe',
        scid: manifestScid,
        xboxTitleId: '71B6A9D4',
        xboxProductId: '9PEMBEDDED01',
        xboxLoopbackServer: server,
        launchOptions: {
          userDataDir: makeTempDir('userdata'),
          fetchImpl: mockPostExitFetch,
          xboxSession: {
            xuid: '2533274790395904',
            gamertag: 'Wave3Tester',
            authorizationHeader: 'XBL3.0 x=2533274790395904;post_exit_tok',
          },
          xboxAuthProvider: {
            getValidXboxSession: async () => ({
              xuid: '2533274790395904',
              gamertag: 'Wave3Tester',
              authorizationHeader: 'XBL3.0 x=2533274790395904;post_exit_tok',
            }),
            getTokenAndSignatureForUrl: async () => ({
              token: 'XBL3.0 x=2533274790395904;post_exit_tok',
              signature: '',
            }),
          },
        },
      });

      const fin = sessionAndProcessSupervisor.finalizeGameSession(gameId);
      expect(fin).toBeTruthy();
      await fin.postSessionBarrierPromise;

      expect(uploadedUrls.some((u) => u.includes(embeddedRuntimeScid))).toBe(true);
      expect(uploadedUrls.some((u) => u.includes('/Autosave,savedgame'))).toBe(true);
    });
  });

  describe('5. Case-Insensitive Path Resolution & PE Architecture Selection (x64/x86 over ARM64)', () => {
    it('resolves mixed-case MSIXVC relative file paths via resolveCaseInsensitiveRelFile and blocks path traversal', () => {
      const gameDir = makeTempDir('ci-rel');
      const actualSubDir = path.join(gameDir, 'content', 'BINARIES', 'WinGDK');
      fs.mkdirSync(actualSubDir, { recursive: true });
      const actualCfg = path.join(gameDir, 'content', 'MicrosoftGame.Config');
      const actualExe = path.join(actualSubDir, 'GameClient.EXE');
      fs.writeFileSync(actualCfg, '<Game/>');
      fs.writeFileSync(actualExe, buildValidMinimalPe64Buffer('CI-EXE'));

      const resolvedForward = binaryAndManifestInspectors.resolveCaseInsensitiveRelFile(
        gameDir,
        'Content/microsoftgame.config'
      );
      expect(resolvedForward).toBeTruthy();
      expect(fs.realpathSync.native(resolvedForward)).toBe(fs.realpathSync.native(actualCfg));
      const resolvedBackslash = binaryAndManifestInspectors.resolveCaseInsensitiveRelFile(
        gameDir,
        'Content\\Binaries\\wingdk\\gameclient.exe'
      );
      expect(resolvedBackslash).toBeTruthy();
      expect(fs.realpathSync.native(resolvedBackslash)).toBe(fs.realpathSync.native(actualExe));
      expect(
        binaryAndManifestInspectors.resolveCaseInsensitiveRelFile(
          gameDir,
          '../outside.exe'
        )
      ).toBe('');
    });

    it('rejects ARM64 (0xaa64) PE binaries on darwin and x64 win32 while selecting runnable AMD64 (0x8664) / I386 (0x014c) executables', () => {
      const gameDir = makeTempDir('arm64-vs-x64');
      const contentDir = path.join(gameDir, 'Content');
      const winGdkDir = path.join(contentDir, 'Binaries', 'WinGDK');
      fs.mkdirSync(winGdkDir, { recursive: true });

      const arm64Stub = path.join(contentDir, 'GameHelperArm64.exe');
      const x64Game = path.join(winGdkDir, 'RealTitle-WinGDK-Shipping.exe');
      const x86Tool = path.join(winGdkDir, 'Fallback32.exe');

      fs.writeFileSync(arm64Stub, buildPeBufferWithMachine(0xaa64, 'ARM64-STUB'));
      fs.writeFileSync(x64Game, buildPeBufferWithMachine(0x8664, 'AMD64-GAME'));
      fs.writeFileSync(x86Tool, buildPeBufferWithMachine(0x014c, 'I386-GAME'));

      const armHeader = binaryAndManifestInspectors.inspectWindowsExecutableHeader(arm64Stub, {
        strictPe: true,
      });
      const x64Header = binaryAndManifestInspectors.inspectWindowsExecutableHeader(x64Game, {
        strictPe: true,
      });
      const x86Header = binaryAndManifestInspectors.inspectWindowsExecutableHeader(x86Tool, {
        strictPe: true,
      });

      expect(armHeader.isArm64).toBe(true);
      expect(
        binaryAndManifestInspectors.isCompatibleX86OrX64PeHeader(armHeader, {
          hostPlatform: 'darwin',
          hostArch: 'arm64',
        })
      ).toBe(false);
      expect(
        binaryAndManifestInspectors.isCompatibleX86OrX64PeHeader(armHeader, {
          hostPlatform: 'win32',
          hostArch: 'x64',
        })
      ).toBe(false);
      expect(
        binaryAndManifestInspectors.isCompatibleX86OrX64PeHeader(armHeader, {
          hostPlatform: 'win32',
          hostArch: 'arm64',
        })
      ).toBe(true);
      expect(
        binaryAndManifestInspectors.isCompatibleX86OrX64PeHeader(x64Header, {
          hostPlatform: 'darwin',
          hostArch: 'arm64',
        })
      ).toBe(true);
      expect(
        binaryAndManifestInspectors.isCompatibleX86OrX64PeHeader(x86Header, {
          hostPlatform: 'darwin',
          hostArch: 'arm64',
        })
      ).toBe(true);

      // Even if MicrosoftGame.config lists the ARM64 binary first, inspectInstalledXboxGameDir must pick x64
      fs.writeFileSync(
        path.join(contentDir, 'MicrosoftGame.config'),
        `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="Studio.MixedArchTitle" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0"/>
  <TitleId>71B6A9D4</TitleId>
  <StoreId>9PMIXEDARCH1</StoreId>
  <ExecutableList>
    <Executable Name="GameHelperArm64.exe" Id="ArmStub"/>
    <Executable Name="Binaries\\WinGDK\\RealTitle-WinGDK-Shipping.exe" Id="Game"/>
  </ExecutableList>
</Game>`
      );

      const bestExe = windowsXboxOrchestrator.findBestX86OrX64WindowsExe(gameDir, {
        strictPe: true,
        platform: 'darwin',
        arch: 'arm64',
      });
      expect(bestExe).toBe(x64Game);

      const inspectedDarwin = windowsXboxOrchestrator.inspectInstalledXboxGameDir(gameDir, {
        platform: 'darwin',
        strictPe: true,
      });
      expect(inspectedDarwin).toBeTruthy();
      expect(inspectedDarwin.executablePath).toBe(x64Game);

      const inspectedWin64 = windowsXboxOrchestrator.inspectInstalledXboxGameDir(gameDir, {
        platform: 'win32',
        strictPe: true,
      });
      expect(inspectedWin64).toBeTruthy();
      expect(inspectedWin64.executablePath).toBe(x64Game);
    });
  });

  describe('6. Dual-OS Windows (win32): Registered GamingServices Appx vs True Clientless Injector', () => {
    function createSyntheticWinXboxInstall(rootDir: string) {
      const contentDir = path.join(rootDir, 'Content');
      const exeDir = path.join(contentDir, 'Binaries', 'WinGDK');
      fs.mkdirSync(exeDir, { recursive: true });

      const exePath = path.join(exeDir, 'WinDualModeGame.exe');
      const retailXgrDll = path.join(exeDir, 'xgameruntime.dll');
      const retailGiDll = path.join(exeDir, 'GameInput.dll');

      fs.writeFileSync(exePath, buildValidMinimalPe64Buffer('WIN-DUAL-EXE'));
      fs.writeFileSync(retailXgrDll, buildValidMinimalPe64Buffer('MSFT-RETAIL-WIN-XGR'));
      fs.writeFileSync(retailGiDll, buildValidMinimalPe64Buffer('MSFT-RETAIL-WIN-GI'));

      fs.writeFileSync(
        path.join(contentDir, 'MicrosoftGame.config'),
        `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="Studio.WinDualModeGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.2.0.0"/>
  <TitleId>71B6A9D4</TitleId>
  <StoreId>9PWINDUAL001</StoreId>
  <ExecutableList>
    <Executable Name="Binaries\\WinGDK\\WinDualModeGame.exe" Id="Game"/>
  </ExecutableList>
</Game>`
      );

      fs.writeFileSync(
        path.join(contentDir, 'AppxManifest.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="Studio.WinDualModeGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.2.0.0" ProcessorArchitecture="x64"/>
  <Applications>
    <Application Id="App" Executable="Binaries\\WinGDK\\WinDualModeGame.exe"/>
  </Applications>
</Package>`
      );

      fs.writeFileSync(
        path.join(rootDir, '.onelauncher-xbox-receipt.json'),
        JSON.stringify({
          status: 'completed',
          xboxProductId: '9PWINDUAL001',
          packageFamilyName: 'Studio.WinDualModeGame_8wekyb3d8bbwe',
          xboxTitleId: '71B6A9D4',
        })
      );

      return { contentDir, exeDir, exePath, retailXgrDll, retailGiDll };
    }

    it('stages clientless bridge DLLs + spawns one_xgr_win_launcher.exe when GamingServices is absent, then restores retail .msft.bak DLLs when GamingServices Appx registration succeeds', async () => {
      const installDir = makeTempDir('win32-dual-xbox');
      const winHomedir = makeTempDir('win32-home');
      const userDataDir = makeTempDir('win32-userdata');
      const { exePath, retailXgrDll, retailGiDll } = createSyntheticWinXboxInstall(installDir);

      // --- Phase A: True Clientless Windows Launch (GamingServices absent) ---
      const spawnedCallsA: Array<{ cmd: string; args: string[]; opts: any }> = [];
      const mockProcA = new MockChildProcess(51001);

      const clientlessLaunch = await sessionAndProcessSupervisor.launchGame(
        {
          gameId: 'xbox-win32-clientless',
          platformId: 'xbox',
          platformGameId: '9PWINDUAL001',
          title: 'Win Dual Mode Game',
          installPath: installDir,
          executablePath: exePath,
          launchArguments: '-windowed',
        },
        {
          platform: 'win32',
          arch: 'x64',
          homedir: winHomedir,
          userDataDir,
          hasGamingServices: false,
          xboxSession: { xuid: '2533274790395904', gamertag: 'WinClientless' },
          xboxAuthProvider: {
            getValidXboxSession: async () => ({
              xuid: '2533274790395904',
              gamertag: 'WinClientless',
            }),
          },
          gameSpawnFn: (cmd: string, args: string[], opts: any) => {
            spawnedCallsA.push({ cmd, args, opts });
            return mockProcA;
          },
        }
      );

      expect(clientlessLaunch.success).toBe(true);
      expect(clientlessLaunch.session.launchMethod).toBe('xbox_win_clientless_injector');
      expect(spawnedCallsA.length).toBe(1);
      expect(path.basename(spawnedCallsA[0].cmd)).toBe('one_xgr_win_launcher.exe');
      expect(spawnedCallsA[0].args).toEqual([
        '--dll',
        retailXgrDll,
        '--',
        exePath,
        '-windowed',
      ]);
      expect(Number(spawnedCallsA[0].opts.env.ONE_XGR_PORT)).toBeGreaterThan(0);
      expect(spawnedCallsA[0].opts.env.ONE_XGR_KEY).toMatch(/^[0-9a-f]{64}$/);

      // Retail DLLs were backed up to .msft.bak and replaced by One Launcher bridges
      expect(fs.existsSync(`${retailXgrDll}.msft.bak`)).toBe(true);
      expect(fs.existsSync(`${retailGiDll}.msft.bak`)).toBe(true);
      expect(
        fs.readFileSync(retailXgrDll).includes(Buffer.from('OneLauncher.XGRBridge.v1', 'utf8'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(installDir, wineAndCrossOverManager.XGR_STAGED_MANIFEST_FILENAME))
      ).toBe(true);

      // Cleanly close Phase A session before Phase B
      const entryA = engineStateRegistry.activeSessions.get('xbox-win32-clientless');
      if (entryA?.pollTimer) clearInterval(entryA.pollTimer);
      if (entryA?.xboxLoopbackServer?.close) await entryA.xboxLoopbackServer.close();
      engineStateRegistry.activeSessions.delete('xbox-win32-clientless');

      // --- Phase B: GamingServices Installed -> Appx Registration + Retail DLL Restoration + AUMID Activation ---
      const psCommandsB: Array<{ cmd: string; args: string[]; env: any }> = [];
      let isRegisteredNow = false;
      const execFileMockB = (
        cmd: string,
        args: string[],
        opts: any,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        const script = String(args[args.length - 1] || '');
        psCommandsB.push({ cmd, args, env: opts?.env });
        if (script.includes('Add-AppxPackage -Register -LiteralPath $env:OL_APPX_MANIFEST')) {
          isRegisteredNow = true;
          cb(null, '', '');
          return;
        }
        if (script.includes('Get-AppxPackage')) {
          if (isRegisteredNow) {
            cb(
              null,
              JSON.stringify({
                Name: 'Studio.WinDualModeGame',
                PackageFamilyName: 'Studio.WinDualModeGame_8wekyb3d8bbwe',
                PackageFullName: 'Studio.WinDualModeGame_1.2.0.0_x64__8wekyb3d8bbwe',
                InstallLocation: path.join(installDir, 'Content'),
              }),
              ''
            );
          } else {
            cb(null, '', '');
          }
          return;
        }
        cb(null, '', '');
      };

      const activatedCalls: Array<{ aumid: string; args: string }> = [];
      const registeredLaunch = await sessionAndProcessSupervisor.launchGame(
        {
          gameId: 'xbox-win32-registered',
          platformId: 'xbox',
          platformGameId: '9PWINDUAL001',
          title: 'Win Dual Mode Game',
          installPath: installDir,
          executablePath: exePath,
        },
        {
          platform: 'win32',
          arch: 'x64',
          homedir: winHomedir,
          userDataDir,
          hasGamingServices: true,
          execFileImpl: execFileMockB,
          enableXboxAumidActivationInTest: true,
          activateXboxApplicationFn: async (aumid: string, launchArgs: string) => {
            activatedCalls.push({ aumid, args: launchArgs });
            return { activated: true, pid: 52002 };
          },
          killImpl: () => true,
        }
      );

      expect(registeredLaunch.success).toBe(true);
      expect(registeredLaunch.session.launchMethod).toBe('xbox_aumid_com');
      expect(activatedCalls.length).toBe(1);
      expect(activatedCalls[0].aumid).toBe('Studio.WinDualModeGame_8wekyb3d8bbwe!Game');

      // Verify Add-AppxPackage used injection-safe $env:OL_APPX_MANIFEST with -LiteralPath
      const addAppxCall = psCommandsB.find((c) =>
        String(c.args[c.args.length - 1] || '').includes('Add-AppxPackage')
      );
      expect(addAppxCall).toBeTruthy();
      expect(addAppxCall?.env?.OL_APPX_MANIFEST).toBe(path.join(installDir, 'Content', 'AppxManifest.xml'));

      // Verify retail Microsoft DLLs were restored from .msft.bak and staged manifest was removed
      expect(fs.existsSync(`${retailXgrDll}.msft.bak`)).toBe(false);
      expect(fs.existsSync(`${retailGiDll}.msft.bak`)).toBe(false);
      expect(
        fs.readFileSync(retailXgrDll).includes(Buffer.from('MSFT-RETAIL-WIN-XGR', 'utf8'))
      ).toBe(true);
      expect(
        fs.readFileSync(retailGiDll).includes(Buffer.from('MSFT-RETAIL-WIN-GI', 'utf8'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(installDir, wineAndCrossOverManager.XGR_STAGED_MANIFEST_FILENAME))
      ).toBe(false);
    });
  });
});
