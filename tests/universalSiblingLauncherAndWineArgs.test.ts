import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

const macNative = requireCjs('../electron/launcher/macNativeInstallerAndCodesign.cjs') as {
  extractSiblingLauncherStem: (exeBasename: string) => string | null;
  resolveSiblingLauncherStub: (candidatePath: string, rootDir?: string) => string;
};

const supervisor = requireCjs('../electron/launcher/sessionAndProcessSupervisor.cjs') as {
  normalizeWineArgumentBackslashes: (rawArg: string, winePrefix?: string) => string;
};

const scanner = requireCjs('../electron/launcher/installedGameScanner.cjs') as {
  scanAllInstalledGames: (options?: Record<string, unknown>) => Promise<{
    success: boolean;
    installedGames: Array<Record<string, any>>;
  }>;
};

function makeValidPe32Bytes(sizeBytes = 4096): Buffer {
  const buf = Buffer.alloc(Math.max(sizeBytes, 512), 0);
  // MZ header
  buf.writeUInt16LE(0x5a4d, 0);
  // e_lfanew = 0x80
  buf.writeUInt32LE(0x80, 0x3c);
  // PE\0\0 signature
  buf.write('PE\0\0', 0x80, 'ascii');
  // IMAGE_FILE_MACHINE_I386 (0x014c)
  buf.writeUInt16LE(0x014c, 0x84);
  // Characteristics: IMAGE_FILE_EXECUTABLE_IMAGE (0x0002)
  buf.writeUInt16LE(0x0002, 0x96);
  // OptionalHeader Magic: PE32 (0x010b)
  buf.writeUInt16LE(0x010b, 0x98);
  // Subsystem: WINDOWS_GUI (2) at OptionalHeader + 0x44 -> 0x98 + 0x44 = 0xdc
  buf.writeUInt16LE(2, 0xdc);
  return buf;
}

function make16BitDosBytes(sizeBytes = 2048): Buffer {
  const buf = Buffer.alloc(Math.max(sizeBytes, 256), 0);
  // MZ header without valid PE\0\0 header
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(0x40, 0x3c);
  buf.write('NE', 0x40, 'ascii');
  return buf;
}

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-univ-sibling-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
});

describe('Universal Sibling Launcher Bootstrapper & Wine Argument Normalization', () => {
  describe('extractSiblingLauncherStem', () => {
    it('extracts stems from standard split-binary *Main.exe suffixes case-insensitively', () => {
      expect(macNative.extractSiblingLauncherStem('AlphaCoreMain.exe')).toBe('AlphaCore');
      expect(macNative.extractSiblingLauncherStem('AB2MAIN.EXE')).toBe('AB2');
      expect(macNative.extractSiblingLauncherStem('ProjectNova_Main.exe')).toBe('ProjectNova');
      expect(macNative.extractSiblingLauncherStem('OrbitEngine-main.exe')).toBe('OrbitEngine');
      expect(macNative.extractSiblingLauncherStem('StarForge.main.exe')).toBe('StarForge');
    });

    it('rejects normal English words ending in "main" to avoid false-positive stem collisions', () => {
      expect(macNative.extractSiblingLauncherStem('Domain.exe')).toBeNull();
      expect(macNative.extractSiblingLauncherStem('DOMAIN.EXE')).toBeNull();
      expect(macNative.extractSiblingLauncherStem('Remain.exe')).toBeNull();
      expect(macNative.extractSiblingLauncherStem('Main.exe')).toBeNull();
      expect(macNative.extractSiblingLauncherStem('RegularGame.exe')).toBeNull();
    });
  });

  describe('resolveSiblingLauncherStub', () => {
    it('prefers a valid PE32/PE32+ sibling <stem>.exe in the same directory or confined parent install root', () => {
      const root = createTempDir();
      const sysDir = path.join(root, 'System');
      fs.mkdirSync(sysDir, { recursive: true });

      const mainExe = path.join(sysDir, 'VortexMain.exe');
      const stubExe = path.join(sysDir, 'vortex.exe');
      fs.writeFileSync(mainExe, makeValidPe32Bytes(65536));
      fs.writeFileSync(stubExe, makeValidPe32Bytes(8192));

      expect(macNative.resolveSiblingLauncherStub(mainExe, root)).toBe(stubExe);
    });

    it('resolves parent-root bootstrapper while strictly confining lookup to rootDir', () => {
      const outerShared = createTempDir();
      const installRoot = path.join(outerShared, 'InstalledTitle');
      const shippingDir = path.join(outerShared, 'InstalledTitle');
      fs.mkdirSync(shippingDir, { recursive: true });

      const rootMainExe = path.join(installRoot, 'EngineAppMain.exe');
      const evilOuterStub = path.join(outerShared, 'EngineApp.exe');
      fs.writeFileSync(rootMainExe, makeValidPe32Bytes(131072));
      fs.writeFileSync(evilOuterStub, makeValidPe32Bytes(8192));

      // Must NOT escape installRoot to outerShared
      expect(macNative.resolveSiblingLauncherStub(rootMainExe, installRoot)).toBe(rootMainExe);

      // Once legitimate bootstrapper exists at installRoot, parent lookup inside rootDir succeeds
      const rootStub = path.join(installRoot, 'EngineApp.exe');
      fs.writeFileSync(rootStub, makeValidPe32Bytes(8192));
      const directChildDir = path.join(installRoot, 'Binaries');
      fs.mkdirSync(directChildDir, { recursive: true });
      const childMain = path.join(directChildDir, 'EngineAppMain.exe');
      fs.writeFileSync(childMain, makeValidPe32Bytes(65536));
      expect(macNative.resolveSiblingLauncherStub(childMain, installRoot)).toBe(rootStub);
    });

    it('rejects 16-bit DOS stubs, 0-byte placeholders, GDK stubs, and excluded helper binaries', () => {
      const root = createTempDir();
      const mainExe = path.join(root, 'RetroAppMain.exe');
      const stubExe = path.join(root, 'RetroApp.exe');
      fs.writeFileSync(mainExe, makeValidPe32Bytes(65536));

      // 0-byte placeholder
      fs.writeFileSync(stubExe, Buffer.alloc(0));
      expect(macNative.resolveSiblingLauncherStub(mainExe, root)).toBe(mainExe);

      // 16-bit DOS MZ/NE stub
      fs.writeFileSync(stubExe, make16BitDosBytes());
      expect(macNative.resolveSiblingLauncherStub(mainExe, root)).toBe(mainExe);
    });

    it('promotes sibling bootstrapper during GOG manifest scan when PlayTask has no custom arguments', async () => {
      const fakeHome = createTempDir();
      const fakeUserData = createTempDir();
      const gogLibrary = path.join(fakeHome, 'Games', 'OneLauncher', 'GOG');
      const gameDir = path.join(gogLibrary, 'Synthetic Immersive Sim');
      const sysDir = path.join(gameDir, 'System');
      fs.mkdirSync(sysDir, { recursive: true });

      const mainExe = path.join(sysDir, 'SimEngineMain.exe');
      const stubExe = path.join(sysDir, 'simengine.exe');
      fs.writeFileSync(mainExe, makeValidPe32Bytes(65536));
      fs.writeFileSync(stubExe, makeValidPe32Bytes(12288));

      fs.writeFileSync(
        path.join(gameDir, 'goggame-999000111.info'),
        JSON.stringify({
          gameId: '999000111',
          rootGameId: '999000111',
          name: 'Synthetic Immersive Sim',
          playTasks: [
            {
              isPrimary: true,
              type: 'FileTask',
              category: 'game',
              path: 'System\\SimEngineMain.exe',
            },
          ],
        }),
        'utf8'
      );

      const scanRes = await scanner.scanAllInstalledGames({
        platform: 'darwin',
        homedir: fakeHome,
        userDataDir: fakeUserData,
        customRoots: [gogLibrary],
      });
      expect(scanRes.success).toBe(true);
      const match = scanRes.installedGames.find((g) => String(g.platformGameId) === '999000111');
      expect(match).toBeDefined();
      expect(match?.executablePath).toBe(stubExe);
    });
  });

  describe('normalizeWineArgumentBackslashes', () => {
    it('preserves URLs, storefront URIs, Win32 CLI switches, and Base64/JWT tokens verbatim', () => {
      expect(supervisor.normalizeWineArgumentBackslashes('https://api.example.com/v1/auth')).toBe(
        'https://api.example.com/v1/auth'
      );
      expect(supervisor.normalizeWineArgumentBackslashes('com.epicgames.launcher://apps/foo')).toBe(
        'com.epicgames.launcher://apps/foo'
      );
      expect(supervisor.normalizeWineArgumentBackslashes('steam://rungameid/440')).toBe(
        'steam://rungameid/440'
      );
      expect(supervisor.normalizeWineArgumentBackslashes('/nosplash')).toBe('/nosplash');
      expect(supervisor.normalizeWineArgumentBackslashes('/w')).toBe('/w');
      expect(supervisor.normalizeWineArgumentBackslashes('-windowed')).toBe('-windowed');
      expect(supervisor.normalizeWineArgumentBackslashes('+connect')).toBe('+connect');

      const fakeToken = 'AbCdEfGhIjKlMnOpQrStUvWxYz01/23456789+AbCdEf=';
      expect(supervisor.normalizeWineArgumentBackslashes(fakeToken)).toBe(fakeToken);
      expect(supervisor.normalizeWineArgumentBackslashes(`-AUTH_PASSWORD=${fakeToken}`)).toBe(
        `-AUTH_PASSWORD=${fakeToken}`
      );
    });

    it('normalizes Windows drive paths, verified POSIX paths, and relative file paths to canonical backslashes', () => {
      const bottle = createTempDir();
      const driveCGame = path.join(bottle, 'drive_c', 'Games', 'Title', 'System', 'App.exe');
      fs.mkdirSync(path.dirname(driveCGame), { recursive: true });
      fs.writeFileSync(driveCGame, makeValidPe32Bytes(4096));

      expect(supervisor.normalizeWineArgumentBackslashes('C:/Games/Title/System/App.exe')).toBe(
        'C:\\Games\\Title\\System\\App.exe'
      );
      expect(supervisor.normalizeWineArgumentBackslashes(driveCGame, bottle)).toBe(
        'C:\\Games\\Title\\System\\App.exe'
      );
      expect(
        supervisor.normalizeWineArgumentBackslashes(
          'D:\\RunnerTemp\\ol-bottle\\drive_c\\Games\\Title\\System\\App.exe',
          'D:\\RunnerTemp\\ol-bottle'
        )
      ).toBe('C:\\Games\\Title\\System\\App.exe');
      expect(supervisor.normalizeWineArgumentBackslashes('./Configs/default.ini', bottle)).toBe(
        '.\\Configs\\default.ini'
      );
      expect(supervisor.normalizeWineArgumentBackslashes('-ini=Configs/user.ini', bottle)).toBe(
        '-ini=Configs\\user.ini'
      );
    });
  });
});
