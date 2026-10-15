import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';

import type { CanonicalGame } from '../src/contracts/game';
import type {
  ActiveGameSession,
  CompatibilityLayerInfo,
  DownloadTaskState,
  GameLaunchConfig,
  InstalledGameRecord,
} from '../src/contracts/launcher';
import { LauncherService, launcherService } from '../src/services/launcher/launcherService';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import {
  loadUserOverrides,
  saveUserOverride,
  removeUserOverride,
} from '../src/services/storage/userOverrideStorage';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { DownloadManagerDrawer } from '../src/components/Launcher/DownloadManagerDrawer';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';

const require = createRequire(import.meta.url);
const launcherEngine = require('../electron/launcherEngine.cjs');

// ---------------------------------------------------------------------------
// Mock Browser Environment (window, localStorage, CustomEvent) for Headless QA
// ---------------------------------------------------------------------------
class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

const mockStorage = new MockStorage();

if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = mockStorage;
}

if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init?: any) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

const windowEventListeners: Record<string, Function[]> = {};
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: mockStorage,
    location: { hostname: '' },
    addEventListener: (event: string, fn: Function) => {
      windowEventListeners[event] = windowEventListeners[event] || [];
      windowEventListeners[event].push(fn);
    },
    removeEventListener: (event: string, fn: Function) => {
      if (windowEventListeners[event]) {
        windowEventListeners[event] = windowEventListeners[event].filter((f) => f !== fn);
      }
    },
    dispatchEvent: (event: any) => {
      const fns = (windowEventListeners[event.type] || []).slice();
      fns.forEach((f) => f(event));
      return true;
    },
  };
} else if (!(globalThis as any).window.localStorage) {
  (globalThis as any).window.localStorage = mockStorage;
}

// Helper to create files with parent directories
function writeTempFile(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode });
  if (mode !== undefined && process.platform !== 'win32') {
    fs.chmodSync(filePath, mode);
  }
}

describe('Universal Game Launcher & Cross-Platform Install Manager QA Suite', () => {
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
    // Ensure any running test processes are stopped before cleaning up tmpRoot
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
  // 1. MULTI-STOREFRONT LOCAL INSTALLATION SCANNING (macOS ARM64 & Windows x64)
  // =========================================================================
  describe('1. Multi-Storefront Local Installation Scanning (macOS ARM64 & Windows x64)', () => {
    it('scans Steam, GOG, and Epic installations on simulated macOS ARM64 (darwin) filesystem tree', () => {
      const macHome = path.join(tmpRoot, 'mac-home');
      const externalDrive = path.join(tmpRoot, 'Volumes', 'ExternalSSD');

      // --- A. Steam libraryfolders.vdf + appmanifest_*.acf + steamapps/common ---
      const primarySteamApps = path.join(macHome, 'Library/Application Support/Steam/steamapps');
      const externalSteamLib = path.join(externalDrive, 'SteamLibrary');
      const externalSteamApps = path.join(externalSteamLib, 'steamapps');

      const vdfContent = `"libraryfolders"
{
  "0"
  {
    "path" "${path.join(macHome, 'Library/Application Support/Steam')}"
  }
  "1"
  {
    "path" "${externalSteamLib}"
  }
}`;
      writeTempFile(path.join(primarySteamApps, 'libraryfolders.vdf'), vdfContent);

      // Steam Game 1: Native macOS .app bundle (Hades - 1145360)
      writeTempFile(
        path.join(primarySteamApps, 'appmanifest_1145360.acf'),
        `"AppState"
{
  "appid" "1145360"
  "name" "Hades"
  "installdir" "Hades"
  "SizeOnDisk" "15891378176"
  "StateFlags" "4"
  "buildid" "9876543"
}`
      );
      const hadesMacBin = path.join(
        primarySteamApps,
        'common/Hades/Hades.app/Contents/MacOS/Hades'
      );
      writeTempFile(
        path.join(primarySteamApps, 'common/Hades/Hades.app/Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Hades</string></dict></plist>`
      );
      writeTempFile(hadesMacBin, '#!/bin/sh\necho "Hades macOS"\n', 0o755);

      // Steam Game 2: Windows .exe installed on macOS in secondary Steam library (Cyberpunk 2077 - 1091500)
      writeTempFile(
        path.join(externalSteamApps, 'appmanifest_1091500.acf'),
        `"AppState"
{
  "appid" "1091500"
  "name" "Cyberpunk 2077"
  "installdir" "Cyberpunk 2077"
  "SizeOnDisk" "75161927680"
  "StateFlags" "4"
  "buildid" "14556677"
}`
      );
      const cpExe = path.join(
        externalSteamApps,
        'common/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe'
      );
      const cpCrashHandler = path.join(
        externalSteamApps,
        'common/Cyberpunk 2077/UnityCrashHandler64.exe'
      );
      writeTempFile(cpExe, 'MZ-fake-windows-pe-binary-payload');
      writeTempFile(cpCrashHandler, 'MZ-crash-handler');

      // Steam Redistributable (228980) - must be ignored
      writeTempFile(
        path.join(primarySteamApps, 'appmanifest_228980.acf'),
        `"AppState" { "appid" "228980" "name" "Steamworks Common Redistributables" "installdir" "Steamworks Shared" "StateFlags" "4" }`
      );

      // --- B. GOG: macOS .app bundle with embedded goggame-<id>.info + Heroic gog_store/installed.json ---
      const bg3AppDir = path.join(macHome, 'Applications/Baldur\'s Gate 3.app');
      const bg3MacBin = path.join(bg3AppDir, 'Contents/MacOS/BaldursGate3');
      writeTempFile(bg3MacBin, '#!/bin/sh\necho "BG3"\n', 0o755);
      writeTempFile(
        path.join(bg3AppDir, 'Contents/Resources/goggame-1456460669.info'),
        JSON.stringify({
          gameId: '1456460669',
          name: "Baldur's Gate 3",
          version: '4.1.1.5022896',
        })
      );

      // Heroic GOG installed.json (Windows build of Blood Omen on macOS)
      const bloodOmenDir = path.join(macHome, 'Games/Heroic/BloodOmen');
      const bloodOmenExe = path.join(bloodOmenDir, 'Kain.exe');
      writeTempFile(bloodOmenExe, 'MZ-kain-exe');
      writeTempFile(
        path.join(macHome, 'Library/Application Support/heroic/gog_store/installed.json'),
        JSON.stringify({
          installed: [
            {
              appName: '1207658924',
              title: 'Blood Omen: Legacy of Kain',
              install_path: bloodOmenDir,
              platform: 'windows',
              install_size: 650000000,
              version: '1.02',
            },
          ],
        })
      );

      // --- C. Epic: Manifests/*.item + LauncherInstalled.dat + Heroic/Legendary installed.json ---
      const epicManifestsDir = path.join(
        macHome,
        'Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests'
      );
      const alanWakeDir = path.join(macHome, 'Games/Epic/AlanWake2');
      const alanWakeExe = path.join(alanWakeDir, 'AlanWake2.exe');
      writeTempFile(alanWakeExe, 'MZ-alan-wake-2');

      writeTempFile(
        path.join(epicManifestsDir, 'AlanWake2.item'),
        JSON.stringify({
          AppName: 'AlanWake2',
          DisplayName: 'Alan Wake 2',
          InstallLocation: alanWakeDir,
          LaunchExecutable: 'AlanWake2.exe',
          InstallSize: 88000000000,
          AppVersionString: '1.0.16',
          bIsIncompleteInstall: false,
        })
      );

      // Incomplete Epic install - must be skipped
      writeTempFile(
        path.join(epicManifestsDir, 'IncompleteGame.item'),
        JSON.stringify({
          AppName: 'IncompleteGame',
          DisplayName: 'Incomplete Game',
          InstallLocation: path.join(macHome, 'Games/Epic/Incomplete'),
          bIsIncompleteInstall: true,
        })
      );

      // Epic LauncherInstalled.dat
      const celesteInstallDir = path.join(macHome, 'Games/Epic/Celeste');
      const celesteAppBin = path.join(celesteInstallDir, 'Celeste.app/Contents/MacOS/Celeste');
      writeTempFile(celesteAppBin, '#!/bin/sh\necho "Celeste"\n', 0o755);
      writeTempFile(
        path.join(
          macHome,
          'Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat'
        ),
        JSON.stringify({
          InstallationList: [
            {
              AppName: 'Salt',
              DisplayName: 'Celeste',
              InstallLocation: celesteInstallDir,
              AppVersion: '1.4.0.0',
            },
            {
              AppName: 'UE_5.4',
              InstallLocation: path.join(macHome, 'Games/Epic/UE_5.4'),
            },
          ],
        })
      );

      // Heroic / Legendary installed.json
      const controlDir = path.join(macHome, 'Games/Heroic/Control');
      const controlExe = path.join(controlDir, 'Control_DX12.exe');
      writeTempFile(controlExe, 'MZ-control-dx12');
      writeTempFile(
        path.join(
          macHome,
          'Library/Application Support/heroic/legendaryConfig/legendary/installed.json'
        ),
        JSON.stringify({
          Calluna: {
            app_name: 'Calluna',
            title: 'Control',
            install_path: controlDir,
            executable: 'Control_DX12.exe',
            platform: 'Windows',
            install_size: 42000000000,
            version: '1.30',
          },
        })
      );

      // Execute universal scan for darwin
      const scanResult = launcherEngine.scanAllInstalledGames({
        platform: 'darwin',
        homedir: macHome,
        userDataDir,
      });

      expect(scanResult.success).toBe(true);
      const records: InstalledGameRecord[] = scanResult.installedGames;

      // Verify Steamworks Redistributables (228980) and UE_5.4 and IncompleteGame were filtered out
      expect(scanResult.installedSteamAppIds).toContain(1145360);
      expect(scanResult.installedSteamAppIds).toContain(1091500);
      expect(scanResult.installedSteamAppIds).not.toContain(228980);
      expect(records.some((r) => r.platformGameId === 'IncompleteGame')).toBe(false);
      expect(records.some((r) => r.platformGameId === 'UE_5.4')).toBe(false);

      // Verify Steam Native macOS .app discovery
      const hades = records.find((r) => r.platformId === 'steam' && r.platformGameId === '1145360');
      expect(hades).toBeDefined();
      expect(hades?.title).toBe('Hades');
      expect(hades?.executablePath).toBe(hadesMacBin);
      expect(hades?.isWindowsBinaryOnMac).toBe(false);
      expect(hades?.installSize).toBe(15891378176);

      // Verify Steam Windows .exe on macOS discovery + crash handler exclusion
      const cyberpunk = records.find(
        (r) => r.platformId === 'steam' && r.platformGameId === '1091500'
      );
      expect(cyberpunk).toBeDefined();
      expect(cyberpunk?.executablePath).toBe(cpExe);
      expect(cyberpunk?.isWindowsBinaryOnMac).toBe(true);

      // Verify GOG .app bundle with Contents/Resources/goggame-<id>.info
      const bg3 = records.find(
        (r) => r.platformId === 'gog' && r.platformGameId === '1456460669'
      );
      expect(bg3).toBeDefined();
      expect(bg3?.installPath).toBe(bg3AppDir);
      expect(bg3?.executablePath).toBe(bg3MacBin);
      expect(bg3?.isWindowsBinaryOnMac).toBe(false);

      // Verify Heroic GOG installed.json discovery
      const bloodOmen = records.find(
        (r) => r.platformId === 'gog' && r.platformGameId === '1207658924'
      );
      expect(bloodOmen).toBeDefined();
      expect(bloodOmen?.runner).toBe('gogdl');
      expect(bloodOmen?.executablePath).toBe(bloodOmenExe);
      expect(bloodOmen?.isWindowsBinaryOnMac).toBe(true);

      // Verify Epic Manifests/*.item discovery
      const alanWake = records.find(
        (r) => r.platformId === 'epic' && r.platformGameId === 'AlanWake2'
      );
      expect(alanWake).toBeDefined();
      expect(alanWake?.executablePath).toBe(alanWakeExe);
      expect(alanWake?.isWindowsBinaryOnMac).toBe(true);

      // Verify Epic LauncherInstalled.dat discovery
      const celeste = records.find((r) => r.platformId === 'epic' && r.platformGameId === 'Salt');
      expect(celeste).toBeDefined();
      expect(celeste?.executablePath).toBe(celesteAppBin);
      expect(celeste?.isWindowsBinaryOnMac).toBe(false);

      // Verify Heroic / Legendary installed.json discovery
      const control = records.find(
        (r) => r.platformId === 'epic' && r.platformGameId === 'Calluna'
      );
      expect(control).toBeDefined();
      expect(control?.runner).toBe('legendary');
      expect(control?.executablePath).toBe(controlExe);
      expect(control?.isWindowsBinaryOnMac).toBe(true);
    });

    it('scans Steam, GOG, and Epic installations on simulated Windows x64 (win32) filesystem tree', () => {
      const winHome = path.join(tmpRoot, 'win-home');
      const winCustomRoot = path.join(tmpRoot, 'win-drives');

      // --- A. Steam on Windows ---
      const winSteamRoot = path.join(winCustomRoot, 'Steam');
      const winSteamApps = path.join(winSteamRoot, 'steamapps');
      const winSecondaryLib = path.join(winCustomRoot, 'SteamLibraryD');

      writeTempFile(
        path.join(winSteamApps, 'libraryfolders.vdf'),
        `"libraryfolders"
{
  "0" { "path" "${winSteamRoot}" }
  "1" { "path" "${winSecondaryLib}" }
}`
      );

      writeTempFile(
        path.join(winSecondaryLib, 'steamapps/appmanifest_292030.acf'),
        `"AppState"
{
  "appid" "292030"
  "name" "The Witcher 3: Wild Hunt"
  "installdir" "The Witcher 3"
  "SizeOnDisk" "53687091200"
  "StateFlags" "4"
  "buildid" "11223344"
}`
      );
      const witcherExe = path.join(
        winSecondaryLib,
        'steamapps/common/The Witcher 3/bin/x64/witcher3.exe'
      );
      const vcRedistExe = path.join(
        winSecondaryLib,
        'steamapps/common/The Witcher 3/vc_redist.x64.exe'
      );
      const uninsExe = path.join(
        winSecondaryLib,
        'steamapps/common/The Witcher 3/unins000.exe'
      );
      writeTempFile(witcherExe, 'MZ-witcher3-shipping-binary');
      writeTempFile(vcRedistExe, 'MZ-vcredist');
      writeTempFile(uninsExe, 'MZ-uninstaller');

      // --- B. GOG on Windows (goggame-<id>.info in game folder + playTasks) ---
      const hollowKnightDir = path.join(winHome, 'Games/Hollow Knight');
      const hollowKnightExe = path.join(hollowKnightDir, 'Hollow Knight.exe');
      writeTempFile(hollowKnightExe, 'MZ-hollow-knight');
      writeTempFile(
        path.join(hollowKnightDir, 'goggame-1308320804.info'),
        JSON.stringify({
          gameId: '1308320804',
          name: 'Hollow Knight',
          version: '1.5.78.11833',
          playTasks: [
            {
              isPrimary: true,
              category: 'game',
              name: 'Hollow Knight',
              path: 'Hollow Knight.exe',
            },
          ],
        })
      );

      // --- C. Epic on Windows (Manifests/*.item + Heroic/Legendary installed.json) ---
      const winEpicManifestDir = path.join(winCustomRoot, 'Manifests');
      const sifuDir = path.join(winCustomRoot, 'EpicGames/Sifu');
      const sifuExe = path.join(sifuDir, 'Sifu/Binaries/Win64/Sifu-Win64-Shipping.exe');
      writeTempFile(sifuExe, 'MZ-sifu-win64-shipping');
      writeTempFile(
        path.join(winEpicManifestDir, 'Sifu.item'),
        JSON.stringify({
          AppName: 'Sifu',
          DisplayName: 'Sifu',
          InstallLocation: sifuDir,
          LaunchExecutable: 'Sifu/Binaries/Win64/Sifu-Win64-Shipping.exe',
          InstallSize: 22548578304,
          AppVersionString: '1.25',
          bIsIncompleteInstall: false,
        })
      );

      const scanResult = launcherEngine.scanAllInstalledGames({
        platform: 'win32',
        homedir: winHome,
        customRoots: [winSteamRoot, winCustomRoot],
        userDataDir,
      });

      expect(scanResult.success).toBe(true);
      const records: InstalledGameRecord[] = scanResult.installedGames;

      // Verify Steam Windows .exe discovery and isWindowsBinaryOnMac === false on win32
      const witcher = records.find(
        (r) => r.platformId === 'steam' && r.platformGameId === '292030'
      );
      expect(witcher).toBeDefined();
      expect(witcher?.executablePath).toBe(witcherExe);
      expect(witcher?.isWindowsBinaryOnMac).toBe(false);

      // Verify GOG Windows game folder discovery
      const hk = records.find(
        (r) => r.platformId === 'gog' && r.platformGameId === '1308320804'
      );
      expect(hk).toBeDefined();
      expect(hk?.installPath).toBe(hollowKnightDir);
      expect(hk?.executablePath).toBe(hollowKnightExe);
      expect(hk?.isWindowsBinaryOnMac).toBe(false);

      // Verify Epic Windows manifest discovery
      const sifu = records.find((r) => r.platformId === 'epic' && r.platformGameId === 'Sifu');
      expect(sifu).toBeDefined();
      expect(sifu?.executablePath).toBe(sifuExe);
      expect(sifu?.isWindowsBinaryOnMac).toBe(false);
    });
  });

  // =========================================================================
  // 2. COMPATIBILITY LAYER DETECTION ON macOS
  // =========================================================================
  describe('2. Compatibility Layer Detection on macOS (CrossOver, Whisky, GPTK)', () => {
    it('detects simulated CrossOver.app with bottles, Whisky.app with bottles, and game-porting-toolkit on darwin', () => {
      const macHome = path.join(tmpRoot, 'compat-home');

      // 1. CrossOver.app + Bottles
      const crossoverWineBin = path.join(
        macHome,
        'Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'
      );
      writeTempFile(crossoverWineBin, '#!/bin/sh\necho "CrossOver Wine"\n', 0o755);
      fs.mkdirSync(
        path.join(macHome, 'Library/Application Support/CrossOver/Bottles/Steam'),
        { recursive: true }
      );
      fs.mkdirSync(
        path.join(macHome, 'Library/Application Support/CrossOver/Bottles/GOG Galaxy'),
        { recursive: true }
      );

      // 2. Whisky.app + Bottles
      const whiskyWineBin = path.join(
        macHome,
        'Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64'
      );
      writeTempFile(whiskyWineBin, '#!/bin/sh\necho "Whisky Wine64"\n', 0o755);
      fs.mkdirSync(path.join(macHome, 'Applications/Whisky.app'), { recursive: true });
      fs.mkdirSync(
        path.join(macHome, 'Library/Containers/com.isaacmarovitz.Whisky/Bottles/CyberpunkBottle'),
        { recursive: true }
      );

      // 3. Game Porting Toolkit (Heroic tools/game-porting-toolkit)
      const gptkWineBin = path.join(
        macHome,
        'Library/Application Support/heroic/tools/game-porting-toolkit/GPTK-2.0/bin/wine64'
      );
      writeTempFile(gptkWineBin, '#!/bin/sh\necho "GPTK Wine64"\n', 0o755);

      const layers: CompatibilityLayerInfo[] = launcherEngine.detectCompatibilityLayers({
        platform: 'darwin',
        homedir: macHome,
      });

      expect(layers.length).toBeGreaterThanOrEqual(3);

      const crossover = layers.find((l) => l.type === 'crossover');
      expect(crossover).toBeDefined();
      expect(crossover?.binaryPath).toBe(crossoverWineBin);
      expect(crossover?.availableBottles).toEqual(
        expect.arrayContaining(['Steam', 'GOG Galaxy'])
      );

      const whisky = layers.find((l) => l.type === 'whisky');
      expect(whisky).toBeDefined();
      expect(whisky?.binaryPath).toBe(whiskyWineBin);
      expect(whisky?.availableBottles).toContain('CyberpunkBottle');

      const gptk = layers.find((l) => l.type === 'gptk');
      expect(gptk).toBeDefined();
      expect(gptk?.binaryPath).toBe(gptkWineBin);

      // Verify Windows host returns empty compatibility layers list
      const winLayers = launcherEngine.detectCompatibilityLayers({
        platform: 'win32',
        homedir: macHome,
      });
      expect(winLayers).toEqual([]);
    });
  });

  // =========================================================================
  // 3. DIRECT PROCESS LAUNCH, PID TRACKING, STOPGAME & PLAYTIME CALCULATION
  // =========================================================================
  describe('3. Direct Process Launch, PID Tracking, stopGame & Session Playtime Calculation', () => {
    it('spawns a real background process, tracks PID in getRunningGames(), terminates via stopGame(), and calculates sessionMinutesPlayed >= 1', async () => {
      const gameScriptPath = path.join(tmpRoot, 'mock-game.sh');
      writeTempFile(
        gameScriptPath,
        `#!/usr/bin/env node
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => {}, 15000);
`,
        0o755
      );

      const sessionEvents: any[] = [];
      const unsub = launcherEngine.onSessionUpdated((ev: any) => {
        sessionEvents.push(ev);
      });

      try {
        const launchRes = await launcherEngine.launchGame(
          {
            gameId: 'steam-1145360',
            title: 'Hades',
            platformId: 'steam',
            platformGameId: '1145360',
            executablePath: gameScriptPath,
          },
          { userDataDir }
        );

        expect(launchRes.success).toBe(true);
        expect(launchRes.session).toBeDefined();
        expect(typeof launchRes.session.pid).toBe('number');
        expect(launchRes.session.pid).toBeGreaterThan(0);
        expect(launchRes.session.status).toBe('running');
        expect(launchRes.session.launchMethod).toBe('direct');

        // Verify getRunningGames() includes the active session & PID
        const runningBeforeStop = launcherEngine.getRunningGames();
        expect(runningBeforeStop).toHaveLength(1);
        expect(runningBeforeStop[0].gameId).toBe('steam-1145360');
        expect(runningBeforeStop[0].pid).toBe(launchRes.session.pid);

        // Stop the game via stopGame()
        const stopRes = await launcherEngine.stopGame({ gameId: 'steam-1145360' });
        expect(stopRes.success).toBe(true);
        expect(stopRes.sessionMinutesPlayed).toBeGreaterThanOrEqual(1);

        // Verify process is removed from active sessions
        expect(launcherEngine.getRunningGames()).toHaveLength(0);

        // Verify started and stopped events were emitted
        expect(sessionEvents.some((e) => e.event === 'started')).toBe(true);
        const stoppedEvent = sessionEvents.find((e) => e.event === 'stopped');
        expect(stoppedEvent).toBeDefined();
        expect(stoppedEvent.sessionMinutesPlayed).toBeGreaterThanOrEqual(1);
        expect(stoppedEvent.lastPlayed).toBeDefined();
      } finally {
        unsub();
      }
    });

    it('automatically detects natural process exit and emits stopped session with playtime calculation', async () => {
      const shortProcessPath = path.join(tmpRoot, 'short-game.sh');
      writeTempFile(
        shortProcessPath,
        `#!/usr/bin/env node
setTimeout(() => process.exit(0), 40);
`,
        0o755
      );

      let stoppedPayload: any = null;
      const exitPromise = new Promise<void>((resolve) => {
        const unsub = launcherEngine.onSessionUpdated((ev: any) => {
          if (ev.event === 'stopped' && ev.session?.gameId === 'gog-1456460669') {
            stoppedPayload = ev;
            unsub();
            resolve();
          }
        });
      });

      const launchRes = await launcherEngine.launchGame(
        {
          gameId: 'gog-1456460669',
          title: "Baldur's Gate 3",
          platformId: 'gog',
          platformGameId: '1456460669',
          executablePath: shortProcessPath,
        },
        { userDataDir }
      );

      expect(launchRes.success).toBe(true);
      await exitPromise;

      expect(stoppedPayload).not.toBeNull();
      expect(stoppedPayload.sessionMinutesPlayed).toBeGreaterThanOrEqual(1);
      expect(launcherEngine.getRunningGames()).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. DOWNLOAD QUEUE STATE MACHINE
  // =========================================================================
  describe('4. Download Queue State Machine & LauncherService Sync', () => {
    it('transitions through queued/downloading, progress updates, pauseDownload, resumeDownload, cancelDownload, and completed state', async () => {
      const downloadEvents: any[] = [];
      const unsub = launcherEngine.onDownloadUpdated((ev: any) => {
        downloadEvents.push(ev);
      });

      try {
        const installDir = path.join(tmpRoot, 'Downloads', 'GOG');
        const startRes = await launcherEngine.installGame(
          {
            gameId: 'gog-1308320804',
            title: 'Hollow Knight',
            platformId: 'gog',
            platformGameId: '1308320804',
            installDir,
            totalBytes: 1000 * 1024 * 1024,
            manualControl: true,
          },
          { userDataDir }
        );

        expect(startRes.success).toBe(true);
        const taskId = startRes.task.taskId;
        expect(startRes.task.status).toBe('downloading');
        expect(startRes.task.progressPercent).toBe(0);
        expect(startRes.task.speedBytesPerSec).toBeGreaterThan(0);
        expect(startRes.task.etaSeconds).toBeGreaterThan(0);

        // 1. Progress Update (50%)
        const progRes = launcherEngine.updateDownloadTask(
          taskId,
          {
            bytesDownloaded: 500 * 1024 * 1024,
            speedBytesPerSec: 25 * 1024 * 1024,
            etaSeconds: 20,
          },
          { userDataDir }
        );
        expect(progRes.success).toBe(true);
        expect(progRes.task.progressPercent).toBe(50);
        expect(progRes.task.speedBytesPerSec).toBe(25 * 1024 * 1024);
        expect(progRes.task.etaSeconds).toBe(20);

        // 2. Pause Download
        const pauseRes = launcherEngine.pauseDownload(taskId);
        expect(pauseRes.success).toBe(true);
        expect(pauseRes.task.status).toBe('paused');
        expect(pauseRes.task.speedBytesPerSec).toBe(0);

        // 3. Resume Download
        const resumeRes = launcherEngine.resumeDownload(taskId);
        expect(resumeRes.success).toBe(true);
        expect(resumeRes.task.status).toBe('downloading');
        expect(resumeRes.task.speedBytesPerSec).toBeGreaterThan(0);

        // 4. Complete Download -> persists to managed installs
        const finalExe = path.join(installDir, 'Hollow Knight', 'Hollow Knight.app');
        writeTempFile(path.join(finalExe, 'Contents/MacOS/Hollow Knight'), '#!/bin/sh\n', 0o755);

        const completeRes = launcherEngine.updateDownloadTask(
          taskId,
          {
            status: 'completed',
            bytesDownloaded: 1000 * 1024 * 1024,
            executablePath: finalExe,
          },
          { userDataDir }
        );
        expect(completeRes.success).toBe(true);
        expect(completeRes.task.status).toBe('completed');
        expect(completeRes.task.progressPercent).toBe(100);
        expect(completeRes.task.speedBytesPerSec).toBe(0);

        const managed = launcherEngine.loadManagedInstalledGames(userDataDir);
        expect(
          managed.some(
            (r: InstalledGameRecord) =>
              r.platformId === 'gog' && r.platformGameId === '1308320804'
          )
        ).toBe(true);

        // 5. Cancel a second download task
        const secondRes = await launcherEngine.installGame(
          {
            gameId: 'epic-AlanWake2',
            title: 'Alan Wake 2',
            platformId: 'epic',
            platformGameId: 'AlanWake2',
            installDir,
            manualControl: true,
          },
          { userDataDir }
        );
        const cancelRes = launcherEngine.cancelDownload(secondRes.task.taskId);
        expect(cancelRes.success).toBe(true);
        expect(cancelRes.task.status).toBe('cancelled');
        expect(cancelRes.task.speedBytesPerSec).toBe(0);
      } finally {
        unsub();
      }
    });
  });

  // =========================================================================
  // 5. LAUNCHERSERVICE & STEAMLIBRARYACTIONBAR MULTI-STOREFRONT FLOWS
  // =========================================================================
  describe('5. LauncherService & SteamLibraryActionBar Multi-Storefront Actions (Steam, GOG, Epic)', () => {
    const multiStoreGame: CanonicalGame = {
      id: 'steam-292030',
      title: 'The Witcher 3: Wild Hunt',
      sortTitle: 'Witcher 3: Wild Hunt',
      steamAppId: 292030,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '292030',
          installed: false,
          playtimeMinutes: 120,
        },
        {
          platformId: 'gog',
          platformGameId: '1207664643',
          installed: false,
          playtimeMinutes: 340,
        },
        {
          platformId: 'epic',
          platformGameId: 'witcher3-epic',
          installed: false,
          playtimeMinutes: 45,
        },
      ],
      headerImage: 'https://example.com/witcher3-header.jpg',
      capsuleImage: 'https://example.com/witcher3-cover.jpg',
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      genres: ['RPG'],
      tags: ['Open World', 'RPG'],
    };

    it('coordinates install, completion transition, launch, stop, locate, verify, and uninstall across Steam, GOG, and Epic via LauncherService', async () => {
      let downloadListener: ((data: any) => void) | null = null;
      let sessionListener: ((data: any) => void) | null = null;

      const gameInstalledEvents: any[] = [];
      const sessionEndedEvents: any[] = [];
      (globalThis as any).window.addEventListener('antigravity:game-installed', (e: any) =>
        gameInstalledEvents.push(e.detail)
      );
      (globalThis as any).window.addEventListener('antigravity:game-session-ended', (e: any) =>
        sessionEndedEvents.push(e.detail)
      );

      const mockExePath = path.join(tmpRoot, 'Witcher3.app/Contents/MacOS/Witcher3');
      writeTempFile(mockExePath, '#!/bin/sh\n', 0o755);

      (globalThis as any).window.electronAPI = {
        isElectron: true,
        onDownloadUpdated: (cb: (data: any) => void) => {
          downloadListener = cb;
          return () => {
            downloadListener = null;
          };
        },
        onSessionUpdated: (cb: (data: any) => void) => {
          sessionListener = cb;
          return () => {
            sessionListener = null;
          };
        },
        getGameLaunchConfigs: vi.fn().mockResolvedValue({}),
        getRunningGames: vi.fn().mockResolvedValue([]),
        getDownloadQueue: vi.fn().mockResolvedValue([]),
        detectCompatibilityLayers: vi.fn().mockResolvedValue([
          {
            id: 'crossover',
            type: 'crossover',
            name: 'CrossOver',
            binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
            availableBottles: ['Steam', 'GOG'],
          },
        ]),
        scanAllInstalledGames: vi.fn().mockResolvedValue({
          success: true,
          installedGames: [],
          installedSteamAppIds: [],
        }),
        installGame: vi.fn().mockImplementation(async (req: any) => {
          const task: DownloadTaskState = {
            taskId: 'task-gog-w3',
            gameId: req.gameId,
            title: req.title,
            platformId: req.platformId,
            platformGameId: req.platformGameId,
            installDir: req.installDir,
            status: 'downloading',
            progressPercent: 25,
            bytesDownloaded: 250,
            totalBytes: 1000,
            speedBytesPerSec: 500,
            etaSeconds: 2,
            startedAt: new Date().toISOString(),
          };
          return { success: true, task };
        }),
        pauseDownload: vi.fn().mockImplementation(async (taskId: string) => ({
          success: true,
          task: {
            taskId,
            gameId: multiStoreGame.id,
            title: multiStoreGame.title,
            platformId: 'gog',
            platformGameId: '1207664643',
            installDir: tmpRoot,
            status: 'paused',
            progressPercent: 50,
            bytesDownloaded: 500,
            totalBytes: 1000,
            speedBytesPerSec: 0,
            startedAt: new Date().toISOString(),
          },
        })),
        resumeDownload: vi.fn().mockImplementation(async (taskId: string) => ({
          success: true,
          task: {
            taskId,
            gameId: multiStoreGame.id,
            title: multiStoreGame.title,
            platformId: 'gog',
            platformGameId: '1207664643',
            installDir: tmpRoot,
            status: 'downloading',
            progressPercent: 50,
            bytesDownloaded: 500,
            totalBytes: 1000,
            speedBytesPerSec: 500,
            startedAt: new Date().toISOString(),
          },
        })),
        cancelDownload: vi.fn().mockImplementation(async (taskId: string) => ({
          success: true,
          task: {
            taskId,
            gameId: multiStoreGame.id,
            title: multiStoreGame.title,
            platformId: 'gog',
            platformGameId: '1207664643',
            installDir: tmpRoot,
            status: 'cancelled',
            progressPercent: 50,
            bytesDownloaded: 500,
            totalBytes: 1000,
            speedBytesPerSec: 0,
            startedAt: new Date().toISOString(),
          },
        })),
        launchGame: vi.fn().mockImplementation(async (req: any) => {
          const session: ActiveGameSession = {
            sessionId: 'sess-w3',
            gameId: req.gameId,
            title: req.title,
            platformId: req.platformId,
            platformGameId: req.platformGameId,
            pid: 42424,
            startedAt: new Date().toISOString(),
            launchMethod: 'direct',
            executablePath: req.executablePath || mockExePath,
            status: 'running',
          };
          return { success: true, session };
        }),
        stopGame: vi.fn().mockResolvedValue({
          success: true,
          message: 'Stopped The Witcher 3: Wild Hunt',
          sessionMinutesPlayed: 3,
        }),
        verifyGameFiles: vi.fn().mockResolvedValue({
          success: true,
          message: 'Verified installation integrity.',
        }),
        browseLocalFiles: vi.fn().mockResolvedValue({ success: true }),
        selectExecutableDialog: vi.fn().mockResolvedValue(mockExePath),
        saveGameLaunchConfig: vi.fn().mockImplementation(async (cfg: GameLaunchConfig) => ({
          success: true,
          config: cfg,
        })),
        uninstallGame: vi.fn().mockResolvedValue({
          success: true,
          message: 'Uninstalled The Witcher 3: Wild Hunt',
        }),
      };

      const service = new LauncherService();
      await service.initialize();

      expect(service.isInitialized()).toBe(true);
      expect(service.isGameInstalled(multiStoreGame)).toBe(false);

      // 1. Start installation on GOG
      const installRes = await service.startInstall({
        gameId: multiStoreGame.id,
        title: multiStoreGame.title,
        platformId: 'gog',
        platformGameId: '1207664643',
        installDir: tmpRoot,
      });
      expect(installRes.success).toBe(true);
      expect(service.getActiveDownload(multiStoreGame.id)?.status).toBe('downloading');

      // 2. Pause & Resume via service
      await service.pauseDownload('task-gog-w3');
      expect(service.getActiveDownload(multiStoreGame.id)?.status).toBe('paused');

      await service.resumeDownload('task-gog-w3');
      expect(service.getActiveDownload(multiStoreGame.id)?.status).toBe('downloading');

      // 3. Emit download completed from IPC -> transitions game to installed in LauncherService
      downloadListener!({
        task: {
          taskId: 'task-gog-w3',
          gameId: multiStoreGame.id,
          title: multiStoreGame.title,
          platformId: 'gog',
          platformGameId: '1207664643',
          installDir: tmpRoot,
          finalInstallPath: path.join(tmpRoot, 'The Witcher 3'),
          executablePath: mockExePath,
          status: 'completed',
          progressPercent: 100,
          bytesDownloaded: 1000,
          totalBytes: 1000,
          speedBytesPerSec: 0,
          startedAt: new Date().toISOString(),
        },
      });

      expect(service.isGameInstalled(multiStoreGame, 'gog')).toBe(true);
      expect(service.getEffectivePlatformForGame(multiStoreGame)?.platformId).toBe('gog');
      expect(gameInstalledEvents.some((e) => e.gameId === multiStoreGame.id && e.installed === true)).toBe(true);

      // 4. Launch game
      const launchRes = await service.launchGame(multiStoreGame, 'gog');
      expect(launchRes.success).toBe(true);
      expect(service.isGameRunning(multiStoreGame.id)).toBe(true);
      expect(service.getActiveSession(multiStoreGame.id)?.pid).toBe(42424);

      // 5. Stop game and emit session stopped event
      const stopRes = await service.stopGame(multiStoreGame.id);
      expect(stopRes.success).toBe(true);
      expect(service.isGameRunning(multiStoreGame.id)).toBe(false);

      sessionListener!({
        session: launchRes.session,
        event: 'stopped',
        sessionMinutesPlayed: 5,
        durationSeconds: 300,
        lastPlayed: new Date().toISOString(),
      });
      expect(sessionEndedEvents.some((e) => e.gameId === multiStoreGame.id && e.sessionMinutesPlayed === 5)).toBe(true);

      // 6. Verify files & Browse local files
      const verifyRes = await service.verifyGameFiles(multiStoreGame, 'gog');
      expect(verifyRes.success).toBe(true);
      const browseOk = await service.browseLocalFiles(multiStoreGame, 'gog');
      expect(browseOk).toBe(true);

      // 7. Uninstall game -> transitions game back to uninstalled
      const uninstallRes = await service.uninstallGame(multiStoreGame, 'gog');
      expect(uninstallRes.success).toBe(true);
      expect(service.isGameInstalled(multiStoreGame, 'gog')).toBe(false);

      // 8. Locate installed game manually -> links executable and marks installed
      const locatedExe = await service.locateInstalledGame(multiStoreGame, 'epic');
      expect(locatedExe).toBe(mockExePath);
      expect(service.isGameInstalled(multiStoreGame)).toBe(true);
      expect(service.getLaunchConfig(multiStoreGame.id)?.preferredPlatformId).toBe('epic');
    });

    it('renders SteamLibraryActionBar across Install, Installing, Play (Steam/GOG/Epic), CrossOver/Wine, and Running states', async () => {
      // 1. Uninstalled Multi-Storefront Game -> shows Install button + Storefront Switcher
      const uninstalledHtml = renderToString(
        React.createElement(SteamLibraryActionBar, {
          game: multiStoreGame,
        })
      );
      expect(uninstalledHtml).toContain('Install');
      expect(uninstalledHtml).toContain('In Library');
      expect(uninstalledHtml).toContain('Target Storefront');
      expect(uninstalledHtml).toContain('Steam');
      expect(uninstalledHtml).toContain('GOG.com');
      expect(uninstalledHtml).toContain('Epic Games');

      // 2. Installed Game on GOG -> shows Play button + Ready to Play + via GOG.com
      const installedGogGame: CanonicalGame = {
        ...multiStoreGame,
        platforms: [
          { platformId: 'steam', platformGameId: '292030', installed: false },
          {
            platformId: 'gog',
            platformGameId: '1207664643',
            installed: true,
            installPath: '/Users/test/Games/Witcher3',
            installSize: 50 * 1024 * 1024 * 1024,
          },
          { platformId: 'epic', platformGameId: 'witcher3-epic', installed: false },
        ],
      };
      const installedHtml = renderToString(
        React.createElement(SteamLibraryActionBar, {
          game: installedGogGame,
        })
      );
      expect(installedHtml).toContain('Play');
      expect(installedHtml).toContain('Ready to Play');
      expect(installedHtml).toContain('via GOG.com');
      expect(installedHtml).toContain('50.0 GB');

      // 3. Installed Windows Binary on macOS -> shows CrossOver / Wine badge
      const winOnMacGame: CanonicalGame = {
        ...multiStoreGame,
        id: 'epic-alanwake2',
        title: 'Alan Wake 2',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'AlanWake2',
            installed: true,
            installPath: '/Users/test/Games/AlanWake2',
            executablePath: '/Users/test/Games/AlanWake2/AlanWake2.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
      };
      const winOnMacHtml = renderToString(
        React.createElement(SteamLibraryActionBar, {
          game: winOnMacGame,
        })
      );
      expect(winOnMacHtml).toContain('Play');
      expect(winOnMacHtml).toContain('Ready to Play');
      expect(winOnMacHtml).toContain('CrossOver / Wine');

      // 4. Active Download state on singleton launcherService -> shows Installing X%
      delete (globalThis as any).window.electronAPI;
      await launcherService.startInstall({
        gameId: multiStoreGame.id,
        title: multiStoreGame.title,
        platformId: 'steam',
        platformGameId: '292030',
        installDir: '/Users/test/Games',
      });
      const downloadingHtml = renderToString(
        React.createElement(SteamLibraryActionBar, {
          game: multiStoreGame,
        })
      );
      expect(downloadingHtml).toContain('Installing 0%');

      // Render DownloadManagerDrawer while download is active
      const drawerHtml = renderToString(
        React.createElement(DownloadManagerDrawer, {
          isOpen: true,
        })
      );
      expect(drawerHtml).toContain('Downloads &amp; Installations');
      expect(drawerHtml).toContain('The Witcher 3: Wild Hunt');
      expect(drawerHtml).toContain('Downloading');

      // Cancel download so we can test Running state
      const activeTask = launcherService.getActiveDownload(multiStoreGame.id);
      if (activeTask) {
        await launcherService.cancelDownload(activeTask.taskId);
      }
      launcherService.clearCompletedDownloads();

      // 5. Running state on singleton launcherService -> shows Running + Stop button + Active Session
      await launcherService.launchGame(installedGogGame, 'gog');
      const runningHtml = renderToString(
        React.createElement(SteamLibraryActionBar, {
          game: installedGogGame,
        })
      );
      expect(runningHtml).toContain('Running');
      expect(runningHtml).toContain('Stop');
      expect(runningHtml).toContain('Active Session');

      await launcherService.stopGame(installedGogGame.id);

      // 6. Verify GameInstallModal and GameLaunchConfigModal render cleanly
      const installModalHtml = renderToString(
        React.createElement(GameInstallModal, {
          isOpen: true,
          game: multiStoreGame,
          initialPlatformId: 'gog',
          onClose: vi.fn(),
        })
      );
      expect(installModalHtml).toContain('Install Game');
      expect(installModalHtml).toContain('Select Storefront Source');
      expect(installModalHtml).toContain('Start Download &amp; Install');

      const configModalHtml = renderToString(
        React.createElement(GameLaunchConfigModal, {
          isOpen: true,
          game: multiStoreGame,
          onClose: vi.fn(),
        })
      );
      expect(configModalHtml).toContain('Launch &amp; Compatibility Settings');
      expect(configModalHtml).toContain('macOS Compatibility Layer');
      expect(configModalHtml).toContain('Save Configuration');
    });
  });

  // =========================================================================
  // 6. REAL-WORLD INSTALLATION, PROGRESS TRACKING & OS-NATIVE-FIRST / FALLBACK
  // =========================================================================
  describe('6. Real-World Installation, Progress Tracking & OS-Native-First / Translation-Fallback Overhaul', () => {
    it('resolves bundled legendary & gogdl binaries and bridges Epic & GOG OAuth credentials into isolated config files', async () => {
      const tempHome = path.join(tmpRoot, 'cred-home');

      // 1. Verify bundled binaries resolve from electron/bin/arm64/darwin
      const legendaryBin = launcherEngine.findLegendaryBinary({
        homedir: tempHome,
        allowSystemBinariesInTest: true,
      });
      const gogdlBin = launcherEngine.findGogdlBinary({
        homedir: tempHome,
        allowSystemBinariesInTest: true,
      });

      expect(legendaryBin).toBeTruthy();
      expect(gogdlBin).toBeTruthy();
      expect(fs.existsSync(legendaryBin)).toBe(true);
      expect(fs.existsSync(gogdlBin)).toBe(true);
      expect(legendaryBin).toContain(path.join('electron', 'bin'));
      expect(gogdlBin).toContain(path.join('electron', 'bin'));

      // 2. Verify ensureLegendaryConfigAndAuth writes user.json and copies assets.json from Heroic config
      const heroicLegendaryDir = path.join(
        tempHome,
        'Library/Application Support/heroic/legendaryConfig/legendary'
      );
      writeTempFile(
        path.join(heroicLegendaryDir, 'assets.json'),
        JSON.stringify({
          Mac: [{ app_name: 'ece4c58603d04bcb97454be9a7492fa6', app_title: 'Amnesia: The Dark Descent' }],
          Windows: [{ app_name: 'ece4c58603d04bcb97454be9a7492fa6', app_title: 'Amnesia: The Dark Descent' }],
        })
      );

      const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
      const legendaryAuthRes = await launcherEngine.ensureLegendaryConfigAndAuth({
        homedir: tempHome,
        userDataDir,
        skipNetwork: true,
        savedTokens: {
          epic: {
            access_token: 'eg1~mock-epic-access-token',
            refresh_token: 'mock-epic-refresh-token',
            expires_at: futureExpiry,
            account_id: 'epic-account-123',
            displayName: 'UniversalTester',
          },
        },
      });

      const expectedLegendaryDir = path.join(userDataDir, 'legendaryConfig', 'legendary');
      expect(legendaryAuthRes.legendaryConfigPath).toBe(expectedLegendaryDir);
      expect(legendaryAuthRes.env.LEGENDARY_CONFIG_PATH).toBe(expectedLegendaryDir);

      const writtenUserJsonPath = path.join(expectedLegendaryDir, 'user.json');
      const copiedAssetsJsonPath = path.join(expectedLegendaryDir, 'assets.json');
      expect(fs.existsSync(writtenUserJsonPath)).toBe(true);
      expect(fs.existsSync(copiedAssetsJsonPath)).toBe(true);

      const userJson = JSON.parse(fs.readFileSync(writtenUserJsonPath, 'utf8'));
      expect(userJson.access_token).toBe('eg1~mock-epic-access-token');
      expect(userJson.refresh_token).toBe('mock-epic-refresh-token');
      expect(userJson.account_id).toBe('epic-account-123');
      expect(userJson.displayName).toBe('UniversalTester');

      // 3. Verify ensureGogdlAuthConfig writes auth.json under client ID "46899977096215655"
      const gogAuthRes = await launcherEngine.ensureGogdlAuthConfig({
        homedir: tempHome,
        userDataDir,
        savedTokens: {
          gog: {
            access_token: 'mock-gog-access-token-xyz',
            refresh_token: 'mock-gog-refresh-token-xyz',
            user_id: 'gog-user-999',
            expires_in: 3600,
          },
        },
      });

      const expectedGogAuthPath = path.join(userDataDir, 'gog_store', 'auth.json');
      expect(gogAuthRes.gogAuthPath).toBe(expectedGogAuthPath);
      expect(fs.existsSync(expectedGogAuthPath)).toBe(true);

      const gogAuthJson = JSON.parse(fs.readFileSync(expectedGogAuthPath, 'utf8'));
      expect(gogAuthJson['46899977096215655']).toBeDefined();
      expect(gogAuthJson['46899977096215655'].access_token).toBe('mock-gog-access-token-xyz');
      expect(gogAuthJson['46899977096215655'].refresh_token).toBe('mock-gog-refresh-token-xyz');
      expect(gogAuthJson['46899977096215655'].user_id).toBe('gog-user-999');
    });

    it('enforces Epic OS-Native First vs Windows Translation Fallback and parses real-time Legendary CLI progress', async () => {
      const tempHome = path.join(tmpRoot, 'epic-home');
      const heroicLegendaryDir = path.join(
        tempHome,
        'Library/Application Support/heroic/legendaryConfig/legendary'
      );

      // Game A (Amnesia) in BOTH Mac and Windows; Game B (DOOM 64) ONLY in Windows
      writeTempFile(
        path.join(heroicLegendaryDir, 'assets.json'),
        JSON.stringify({
          Mac: [
            {
              app_name: 'ece4c58603d04bcb97454be9a7492fa6',
              app_title: 'Amnesia: The Dark Descent',
              build_version: '1.5.0-mac',
            },
          ],
          Windows: [
            {
              app_name: 'ece4c58603d04bcb97454be9a7492fa6',
              app_title: 'Amnesia: The Dark Descent',
              build_version: '1.5.0-win',
            },
            {
              app_name: '5b60142e120c4f2d88027595c21d4a04',
              app_title: 'DOOM 64',
              build_version: '1.0.2-win',
            },
          ],
        })
      );

      // Mock executable legendary script in <tempHome>/Library/Application Support/heroic/tools/bin/legendary
      const mockLegendaryBin = path.join(
        tempHome,
        'Library/Application Support/heroic/tools/bin/legendary'
      );
      const argsLogFile = path.join(tmpRoot, 'legendary-invocations.json');
      writeTempFile(
        mockLegendaryBin,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const appName = args[1];
const platIdx = args.indexOf('--platform');
const platformVal = platIdx >= 0 ? args[platIdx + 1] : 'Windows';
const baseIdx = args.indexOf('--base-path');
const basePath = baseIdx >= 0 ? args[baseIdx + 1] : process.cwd();

let history = [];
try {
  if (fs.existsSync(${JSON.stringify(argsLogFile)})) {
    history = JSON.parse(fs.readFileSync(${JSON.stringify(argsLogFile)}, 'utf8'));
  }
} catch {}
history.push({ appName, platformVal, basePath, args });
fs.writeFileSync(${JSON.stringify(argsLogFile)}, JSON.stringify(history, null, 2), 'utf8');

process.stdout.write('[cli] INFO: Download size: 145.50 MiB\\n');
process.stdout.write('[cli] INFO: Progress: 55.00% (100/180), Running for 00:00:05, ETA: 00:00:04\\n');
process.stdout.write('[cli] INFO: Downloaded: 80.00 MiB\\n');
process.stdout.write('[cli] INFO:  + Download\\t- 20.00 MiB/s\\n');

const installFolder = path.join(basePath, appName === 'ece4c58603d04bcb97454be9a7492fa6' ? 'Amnesia' : 'DOOM64');
fs.mkdirSync(installFolder, { recursive: true });

let exeRel = '';
if (platformVal === 'Mac') {
  const macBin = path.join(installFolder, 'Amnesia.app', 'Contents', 'MacOS', 'Amnesia');
  fs.mkdirSync(path.dirname(macBin), { recursive: true });
  fs.writeFileSync(macBin, '#!/bin/sh\\necho "Amnesia Mac"\\n', { mode: 0o755 });
  exeRel = 'Amnesia.app';
} else {
  const winExe = path.join(installFolder, 'DOOM64_x64.exe');
  fs.writeFileSync(winExe, 'MZ-doom64-win64');
  exeRel = 'DOOM64_x64.exe';
}

const configDir = process.env.LEGENDARY_CONFIG_PATH;
if (configDir) {
  fs.mkdirSync(configDir, { recursive: true });
  const instPath = path.join(configDir, 'installed.json');
  let inst = {};
  try {
    if (fs.existsSync(instPath)) inst = JSON.parse(fs.readFileSync(instPath, 'utf8'));
  } catch {}
  inst[appName] = {
    app_name: appName,
    title: appName === 'ece4c58603d04bcb97454be9a7492fa6' ? 'Amnesia: The Dark Descent' : 'DOOM 64',
    install_path: installFolder,
    executable: exeRel,
    platform: platformVal,
    install_size: 152567808,
    version: '1.0',
  };
  fs.writeFileSync(instPath, JSON.stringify(inst, null, 2), 'utf8');
}

setTimeout(() => process.exit(0), 30);
`,
        0o755
      );

      // 1. Verify getGameInstallInfo on darwin for Game A (Mac + Windows)
      const infoGameA = await launcherEngine.getGameInstallInfo(
        {
          gameId: 'epic-ece4c58603d04bcb97454be9a7492fa6',
          title: 'Amnesia: The Dark Descent',
          platformId: 'epic',
          platformGameId: 'ece4c58603d04bcb97454be9a7492fa6',
        },
        { platform: 'darwin', homedir: tempHome, userDataDir }
      );
      expect(infoGameA.canDirectDownload).toBe(true);
      expect(infoGameA.availableInstallers).toHaveLength(2);
      expect(infoGameA.availableInstallers[0].id).toBe('epic-mac-native');
      expect(infoGameA.availableInstallers[0].os).toBe('mac');
      expect(infoGameA.availableInstallers[1].id).toBe('epic-win-compat');
      expect(infoGameA.availableInstallers[1].os).toBe('windows');

      // 2. Verify getGameInstallInfo on darwin for Game B (Windows ONLY)
      const infoGameB = await launcherEngine.getGameInstallInfo(
        {
          gameId: 'epic-5b60142e120c4f2d88027595c21d4a04',
          title: 'DOOM 64',
          platformId: 'epic',
          platformGameId: '5b60142e120c4f2d88027595c21d4a04',
        },
        { platform: 'darwin', homedir: tempHome, userDataDir }
      );
      expect(infoGameB.canDirectDownload).toBe(true);
      expect(infoGameB.availableInstallers).toHaveLength(1);
      expect(infoGameB.availableInstallers[0].id).toBe('epic-win-compat');
      expect(infoGameB.availableInstallers[0].os).toBe('windows');
      expect(infoGameB.availableInstallers[0].name).toContain('No macOS Native Build');

      // 3. Install Game A on darwin -> must pass --platform Mac and complete with isWindowsBinaryOnMac: false
      const gameAEvents: DownloadTaskState[] = [];
      const waitForCompletion = (targetGameId: string) =>
        new Promise<DownloadTaskState>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${targetGameId}`)), 5000);
          const unsub = launcherEngine.onDownloadUpdated((ev: any) => {
            if (ev.task?.gameId === targetGameId) {
              gameAEvents.push({ ...ev.task });
              if (ev.task.status === 'completed') {
                clearTimeout(timeout);
                unsub();
                resolve(ev.task);
              } else if (ev.task.status === 'failed') {
                clearTimeout(timeout);
                unsub();
                reject(new Error(ev.task.error || 'Install failed'));
              }
            }
          });
        });

      const installDir = path.join(tmpRoot, 'EpicGamesInstall');
      const completePromiseA = waitForCompletion('epic-ece4c58603d04bcb97454be9a7492fa6');
      await launcherEngine.installGame(
        {
          gameId: 'epic-ece4c58603d04bcb97454be9a7492fa6',
          title: 'Amnesia: The Dark Descent',
          platformId: 'epic',
          platformGameId: 'ece4c58603d04bcb97454be9a7492fa6',
          installDir,
        },
        { platform: 'darwin', homedir: tempHome, userDataDir }
      );

      const completedTaskA = await completePromiseA;
      expect(completedTaskA.status).toBe('completed');
      expect(completedTaskA.progressPercent).toBe(100);
      expect(completedTaskA.isWindowsBinaryOnMac).toBe(false);
      expect(completedTaskA.executablePath).toContain(path.join('Amnesia.app', 'Contents', 'MacOS', 'Amnesia'));

      // Verify intermediate progress update from Legendary CLI output (55%) was captured
      expect(gameAEvents.some((t) => t.progressPercent === 55)).toBe(true);

      // 4. Install Game B on darwin -> must automatically fall back to --platform Windows and complete with isWindowsBinaryOnMac: true
      const completePromiseB = waitForCompletion('epic-5b60142e120c4f2d88027595c21d4a04');
      await launcherEngine.installGame(
        {
          gameId: 'epic-5b60142e120c4f2d88027595c21d4a04',
          title: 'DOOM 64',
          platformId: 'epic',
          platformGameId: '5b60142e120c4f2d88027595c21d4a04',
          installDir,
        },
        { platform: 'darwin', homedir: tempHome, userDataDir }
      );

      const completedTaskB = await completePromiseB;
      expect(completedTaskB.status).toBe('completed');
      expect(completedTaskB.progressPercent).toBe(100);
      expect(completedTaskB.isWindowsBinaryOnMac).toBe(true);
      expect(completedTaskB.executablePath).toContain('DOOM64_x64.exe');

      // Verify recorded CLI arguments
      const invocations = JSON.parse(fs.readFileSync(argsLogFile, 'utf8'));
      expect(invocations).toHaveLength(2);
      expect(invocations[0].appName).toBe('ece4c58603d04bcb97454be9a7492fa6');
      expect(invocations[0].platformVal).toBe('Mac');
      expect(invocations[1].appName).toBe('5b60142e120c4f2d88027595c21d4a04');
      expect(invocations[1].platformVal).toBe('Windows');
    });

    it('monitors real-time Steam downloads via appmanifest_<appId>.acf + logs/content_log.txt through completion', async () => {
      const tempHome = path.join(tmpRoot, 'steam-monitor-home');
      const steamRoot = path.join(tempHome, 'Library/Application Support/Steam');
      const steamApps = path.join(steamRoot, 'steamapps');
      const steamLogs = path.join(steamRoot, 'logs');

      // Initial state: Portal 2 (AppID 620) 25% downloaded at 80.000 Mbps
      writeTempFile(
        path.join(steamApps, 'appmanifest_620.acf'),
        `"AppState"
{
  "appid" "620"
  "name" "Portal 2"
  "installdir" "Portal 2"
  "StateFlags" "1026"
  "BytesToDownload" "100000000"
  "BytesDownloaded" "25000000"
}`
      );
      writeTempFile(
        path.join(steamLogs, 'content_log.txt'),
        `[2026-10-15 12:00:00] AppID 620 update started : download 25000000/100000000\n[2026-10-15 12:00:01] Current download rate: 80.000 Mbps\n`
      );

      let reached25Percent = false;
      let completedTask: DownloadTaskState | null = null;

      const completionPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for Steam monitor')), 5000);
        const unsub = launcherEngine.onDownloadUpdated((ev: any) => {
          const t: DownloadTaskState | undefined = ev.task;
          if (!t || t.gameId !== 'steam-620') return;

          if (
            !reached25Percent &&
            t.progressPercent === 25 &&
            t.bytesDownloaded === 25000000 &&
            t.totalBytes === 100000000 &&
            t.speedBytesPerSec === 10000000
          ) {
            reached25Percent = true;

            // Transition manifest to StateFlags "4" and create Portal 2 binary
            const portalBin = path.join(
              steamApps,
              'common/Portal 2/Portal2.app/Contents/MacOS/Portal2'
            );
            writeTempFile(portalBin, '#!/bin/sh\necho "Portal 2"\n', 0o755);
            writeTempFile(
              path.join(steamApps, 'appmanifest_620.acf'),
              `"AppState"
{
  "appid" "620"
  "name" "Portal 2"
  "installdir" "Portal 2"
  "StateFlags" "4"
  "BytesToDownload" "100000000"
  "BytesDownloaded" "100000000"
  "SizeOnDisk" "250000000"
}`
            );
          }

          if (t.status === 'completed') {
            completedTask = t;
            clearTimeout(timeout);
            unsub();
            resolve();
          }
        });
      });

      await launcherEngine.installGame(
        {
          gameId: 'steam-620',
          title: 'Portal 2',
          platformId: 'steam',
          platformGameId: '620',
          steamAppId: 620,
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir,
          steamPollIntervalMs: 30,
        }
      );

      await completionPromise;

      expect(reached25Percent).toBe(true);
      expect(completedTask).not.toBeNull();
      expect(completedTask!.status).toBe('completed');
      expect(completedTask!.progressPercent).toBe(100);
      expect(completedTask!.finalInstallPath).toBe(path.join(steamApps, 'common/Portal 2'));
      expect(completedTask!.executablePath).toBe(
        path.join(steamApps, 'common/Portal 2/Portal2.app/Contents/MacOS/Portal2')
      );
    });

    it('immediately clears active/stuck download tasks when launcherService.setManualInstallStatus marks a game as installed', async () => {
      delete (globalThis as any).window.electronAPI;

      const stuckGame: CanonicalGame = {
        id: 'steam-400',
        title: 'Portal',
        sortTitle: 'Portal',
        steamAppId: 400,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '400',
            installed: false,
            playtimeMinutes: 0,
          },
        ],
        headerImage: 'https://example.com/portal.jpg',
        capsuleImage: 'https://example.com/portal-cover.jpg',
        developers: ['Valve'],
        publishers: ['Valve'],
        genres: ['Puzzle'],
        tags: ['Puzzle'],
      };

      await launcherService.startInstall({
        gameId: stuckGame.id,
        title: stuckGame.title,
        platformId: 'steam',
        platformGameId: '400',
        steamAppId: 400,
        installDir: '/Users/test/Games',
      });

      expect(launcherService.getActiveDownload(stuckGame.id)).toBeDefined();
      expect(launcherService.getActiveDownload(stuckGame.id)?.status).toBe('downloading');

      // Override install status manually -> must immediately clear active download and mark installed
      launcherService.setManualInstallStatus(stuckGame, true, 'steam');

      expect(launcherService.getActiveDownload(stuckGame.id)).toBeUndefined();
      expect(launcherService.isGameInstalled(stuckGame, 'steam')).toBe(true);

      // Clean up singleton state
      launcherService.setManualInstallStatus(stuckGame, false, 'steam');
      launcherService.clearCompletedDownloads();
    });
  });

  // =========================================================================
  // 7. COMPATIBILITY LAYER AUTO-PROVISIONING, WINE/CROSSOVER HARDENING & PLAYTIME GUARD
  // =========================================================================
  describe('7. Compatibility Layer Auto-Provisioning, Wine/CrossOver Launch Hardening & Playtime Guard', () => {
    it('provisions CrossOver and GPTK/Wine compatibility layer environments via ensureCompatibilityLayerReady', async () => {
      const tempHome = path.join(tmpRoot, 'compat-ready-home');
      const bottlesDir = path.join(tempHome, 'Library/Application Support/CrossOver/Bottles');
      const oneLauncherBottleDir = path.join(bottlesDir, 'OneLauncher');
      const steamBottleDir = path.join(bottlesDir, 'Steam');
      fs.mkdirSync(oneLauncherBottleDir, { recursive: true });
      fs.mkdirSync(steamBottleDir, { recursive: true });

      // 1. CrossOver layer readiness & environment hardening
      const crossoverEnv: Record<string, string> = {};
      const crossoverRes = await launcherEngine.ensureCompatibilityLayerReady(
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          binaryPath: path.join(
            tempHome,
            'Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'
          ),
          bottlesDir,
          availableBottles: ['OneLauncher', 'Steam'],
        },
        {},
        crossoverEnv,
        { homedir: tempHome }
      );

      expect(crossoverEnv.CX_BOTTLE).toBe('OneLauncher');
      expect(crossoverEnv.WINEPREFIX).toBe(oneLauncherBottleDir);
      expect(crossoverEnv.WINEESYNC).toBe('1');
      expect(crossoverEnv.WINEMSYNC).toBe('1');
      expect(crossoverRes.targetBottle).toBe('OneLauncher');
      expect(crossoverRes.winePrefix).toBe(oneLauncherBottleDir);

      // 2. GPTK / Wine layer readiness & prefix creation on disk
      const gptkEnv: Record<string, string> = {};
      const gptkRes = await launcherEngine.ensureCompatibilityLayerReady(
        {
          id: 'gptk',
          type: 'gptk',
          name: 'Game Porting Toolkit (GPTK-2.0)',
          binaryPath: path.join(
            tempHome,
            'Library/Application Support/heroic/tools/game-porting-toolkit/GPTK-2.0/bin/wine64'
          ),
          availableBottles: [],
        },
        {},
        gptkEnv,
        { homedir: tempHome }
      );

      const expectedPrefix = path.join(tempHome, 'Games/OneLauncher/Prefixes/default');
      expect(gptkEnv.WINEPREFIX).toBe(expectedPrefix);
      expect(fs.existsSync(expectedPrefix)).toBe(true);
      expect(gptkEnv.WINEMSYNC).toBe('1');
      expect(gptkEnv.WINEESYNC).toBe('1');
      expect(gptkEnv.WINEDLLOVERRIDES).toContain('winemenubuilder.exe=d');
      expect(gptkRes.winePrefix).toBe(expectedPrefix);
    });

    it('detects fast-exit process crashes, captures stderr Fatal Error, and guards playtime at 0 minutes', async () => {
      const tempHome = path.join(tmpRoot, 'crash-test-home');
      const tempUserData = path.join(tmpRoot, 'crash-test-userdata');
      fs.mkdirSync(tempHome, { recursive: true });
      fs.mkdirSync(tempUserData, { recursive: true });

      const crashScriptPath = path.join(tempHome, 'crash-game.sh');
      writeTempFile(
        crashScriptPath,
        `#!/bin/sh
echo "Fatal Error: Unable to initialize bottle" >&2
exit 1
`,
        0o755
      );
      try {
        require('node:child_process').execFileSync(crashScriptPath, { stdio: 'ignore' });
      } catch {}

      const sessionEvents: any[] = [];
      const unsub = launcherEngine.onSessionUpdated((ev: any) => {
        sessionEvents.push(ev);
      });

      try {
        const launchRes = await launcherEngine.launchGame(
          {
            gameId: 'crash-test-game',
            title: 'Crash Test',
            platformId: 'epic',
            platformGameId: 'crash1',
            executablePath: crashScriptPath,
            launchMethod: 'direct',
          },
          {
            homedir: tempHome,
            userDataDir: tempUserData,
            startupWaitMs: 250,
          }
        );

        expect(launchRes.success).toBe(false);
        expect(launchRes.sessionMinutesPlayed).toBe(0);
        expect(launchRes.error).toContain('Fatal Error: Unable to initialize bottle');

        const stoppedEvent = sessionEvents.find(
          (e) => e.event === 'stopped' && e.session?.gameId === 'crash-test-game'
        );
        expect(stoppedEvent).toBeDefined();
        expect(stoppedEvent.sessionMinutesPlayed).toBe(0);
        expect(stoppedEvent.error).toContain('Fatal Error: Unable to initialize bottle');
        expect(launcherEngine.getRunningGames()).toHaveLength(0);
      } finally {
        unsub();
      }
    });
  });

  // =========================================================================
  // 8. NON-STEAM PHANTOM STEAM PLATFORM ELIMINATION & DECLUTTERED ACTION BAR UI
  // =========================================================================
  describe('8. Non-Steam Phantom Steam Platform Elimination, Playtime Folding & SteamLibraryActionBar Decluttered UI', () => {
    it('prevents non-Steam installs from saving phantom Steam appId in one_launcher_installed.json and strips cached phantom Steam platforms while folding playtime in sanitizeGameCatalog', async () => {
      // 1. Install an Epic game with steamAppId metadata (20 Minutes Till Dawn) and complete via updateDownloadTask
      const installDir = path.join(tmpRoot, 'OneLauncher', 'Epic');
      const startRes = await launcherEngine.installGame(
        {
          gameId: 'steam-1966900',
          title: '20 Minutes Till Dawn',
          platformId: 'epic',
          platformGameId: 'd9d5bf08f174402a8d1a002b2f52a08b',
          steamAppId: 1966900,
          installDir,
          totalBytes: 250 * 1024 * 1024,
          manualControl: true,
        },
        { userDataDir }
      );
      expect(startRes.success).toBe(true);

      const finalExe = path.join(installDir, '20 Minutes Till Dawn', 'MinutesTillDawn.exe');
      writeTempFile(finalExe, 'MZ-20-minutes-till-dawn');

      const completeRes = launcherEngine.updateDownloadTask(
        startRes.task.taskId,
        {
          status: 'completed',
          bytesDownloaded: 250 * 1024 * 1024,
          executablePath: finalExe,
        },
        { userDataDir }
      );
      expect(completeRes.success).toBe(true);

      //Also verify direct upsertManagedInstallRecord strips appId for non-steam
      launcherEngine.upsertManagedInstallRecord(
        {
          platformId: 'epic',
          platformGameId: 'd9d5bf08f174402a8d1a002b2f52a08b',
          appId: 1966900,
          title: '20 Minutes Till Dawn',
          installPath: path.join(installDir, '20 Minutes Till Dawn'),
          executablePath: finalExe,
          runner: 'legendary',
        },
        userDataDir
      );

      const installedJsonPath = path.join(userDataDir, 'one_launcher_installed.json');
      expect(fs.existsSync(installedJsonPath)).toBe(true);
      const savedRecords = JSON.parse(fs.readFileSync(installedJsonPath, 'utf8'));
      const epicRecord = savedRecords.find(
        (r: any) =>
          r.platformId === 'epic' &&
          r.platformGameId === 'd9d5bf08f174402a8d1a002b2f52a08b'
      );
      expect(epicRecord).toBeDefined();
      expect(epicRecord.appId).toBeUndefined();

      // 2. Verify sanitizeGameCatalog strips cached phantom 'steam' platform on Epic-owned game while folding playtime
      const pollutedEpicGame: CanonicalGame = {
        id: 'steam-1966900',
        title: '20 Minutes Till Dawn',
        sortTitle: '20 Minutes Till Dawn',
        steamAppId: 1966900,
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'd9d5bf08f174402a8d1a002b2f52a08b',
            playtimeMinutes: 17,
            installed: true,
          },
          {
            platformId: 'steam',
            platformGameId: '1966900',
            playtimeMinutes: 2,
            installed: true,
            installPath: '/Users/test/Games/OneLauncher/Epic/20MinutesTillDawn',
          },
        ],
        headerImage:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1966900/header.jpg',
        developers: ['flanne'],
        publishers: ['Erabit'],
        genres: ['Action', 'Indie'],
        tags: ['Action Roguelike'],
      };

      const sanitized = sanitizeGameCatalog([pollutedEpicGame], {
        allowNewPurchases: true,
        validSteamAppIds: new Set([400]),
      } as any);

      expect(sanitized).toHaveLength(1);
      const cleanedGame = sanitized[0];
      expect(cleanedGame.steamAppId).toBe(1966900);
      expect(cleanedGame.platforms).toHaveLength(1);
      expect(cleanedGame.platforms[0].platformId).toBe('epic');
      expect(cleanedGame.platforms[0].platformGameId).toBe('d9d5bf08f174402a8d1a002b2f52a08b');
      expect(cleanedGame.platforms[0].playtimeMinutes).toBe(19);
    });

    it('declutters SteamLibraryActionBar main row and moves Manual Install & Match Wizard into the Manage Game cog menu', async () => {
      delete (globalThis as any).window.electronAPI;

      const testGame: CanonicalGame = {
        id: 'epic-20mtd',
        title: '20 Minutes Till Dawn',
        sortTitle: '20 Minutes Till Dawn',
        steamAppId: 1966900,
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'd9d5bf08f174402a8d1a002b2f52a08b',
            installed: false,
            playtimeMinutes: 19,
          },
        ],
        headerImage: 'https://example.com/20mtd.jpg',
        developers: ['flanne'],
        publishers: ['Erabit'],
        genres: ['Action'],
        tags: ['Roguelike'],
      };

      const onFixMatch = vi.fn();
      const onToggleInstallStatus = vi.fn();

      // Stateful hook harness for SteamLibraryActionBar
      const states: any[] = [];
      const refs: { current: any }[] = [];

      const findElements = (node: any, predicate: (el: any) => boolean, acc: any[] = []): any[] => {
        if (!node || typeof node !== 'object') return acc;
        if (Array.isArray(node)) {
          for (const child of node) findElements(child, predicate, acc);
          return acc;
        }
        if (predicate(node)) acc.push(node);
        if (node.props && node.props.children) {
          findElements(node.props.children, predicate, acc);
        }
        return acc;
      };

      const getTextContent = (node: any): string => {
        if (node === null || node === undefined || typeof node === 'boolean') return '';
        if (typeof node === 'string' || typeof node === 'number') return String(node);
        if (Array.isArray(node)) return node.map(getTextContent).join('');
        if (typeof node === 'object' && node.props) return getTextContent(node.props.children);
        return '';
      };

      const renderActionBar = () => {
        let stateIdx = 0;
        let refIdx = 0;
        const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
        const prevH = internals.H;
        internals.H = {
          useState(initial: any) {
            const idx = stateIdx++;
            if (idx >= states.length) {
              states.push(typeof initial === 'function' ? initial() : initial);
            }
            const setState = (updater: any) => {
              states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
            };
            return [states[idx], setState];
          },
          useRef(initial: any) {
            const idx = refIdx++;
            if (idx >= refs.length) {
              refs.push({ current: initial });
            }
            return refs[idx];
          },
          useEffect() {},
          useMemo(fn: () => any) {
            return fn();
          },
          useCallback(fn: any) {
            return fn;
          },
        };
        try {
          const vnode = (SteamLibraryActionBar as any)({
            game: testGame,
            onFixMatch,
            onToggleInstallStatus,
          });
          const html = renderToString(vnode);
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      // 1. Closed state: verify main bar row does NOT render standalone HardDrive or Wand buttons
      const closedRender = renderActionBar();
      expect(closedRender.html).not.toContain('aria-label="Mark as manually installed"');
      expect(closedRender.html).not.toContain('aria-label="Mark as uninstalled (cloud only)"');
      expect(closedRender.html).not.toContain('title="Fix &amp; Match Wizard"');
      expect(closedRender.html).not.toContain('title="Fix match, cover poster &amp; scraped metadata..."');
      expect(closedRender.html).not.toContain('Mark as Manually Installed');
      expect(closedRender.html).not.toContain('Match &amp; Metadata Wizard...');

      // 2. Click Settings Cog ('Manage Game') button to open menu
      const manageCogBtn = findElements(
        closedRender.vnode,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
      )[0];
      expect(manageCogBtn).toBeDefined();
      manageCogBtn.props.onClick();

      const openRender = renderActionBar();
      expect(openRender.html).toContain('Mark as Manually Installed');
      expect(openRender.html).toContain('Match &amp; Metadata Wizard...');

      // 3. Click 'Mark as Manually Installed' inside the Manage Game menu -> toggles manual install status
      const manualInstallBtn = findElements(
        openRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Mark as Manually Installed')
      )[0];
      expect(manualInstallBtn).toBeDefined();
      await manualInstallBtn.props.onClick();

      expect(launcherService.isGameInstalled(testGame, 'epic')).toBe(true);
      expect(onToggleInstallStatus).toHaveBeenCalledTimes(1);

      // Re-open Manage Game menu and verify label switched to 'Mark as Uninstalled (Cloud Only)'
      const afterInstallClosed = renderActionBar();
      expect(afterInstallClosed.html).toContain('Play');
      expect(afterInstallClosed.html).toContain('Ready to Play');

      const manageCogBtn2 = findElements(
        afterInstallClosed.vnode,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
      )[0];
      manageCogBtn2.props.onClick();

      const afterInstallOpen = renderActionBar();
      expect(afterInstallOpen.html).toContain('Mark as Uninstalled (Cloud Only)');

      // Clean up manual install status
      await launcherService.setManualInstallStatus(testGame, false, 'epic');
    });
  });

  // =========================================================================
  // 9. GOG TOKEN RENEWAL, GOGDL SUBDIRECTORY & SIZE TUPLE PARSING & GAMEINSTALLMODAL UX
  // =========================================================================
  describe('9. GOG OAuth Token Renewal, gogdl Subdirectory & Size Tuple Parsing, and GameInstallModal Build Selector UX', () => {
    it('renews expired GOG OAuth tokens via ensureGogdlAuthConfig and writes accurate loginTime to auth.json', async () => {
      const tempHome = path.join(tmpRoot, 'gog-renew-home');
      const tempUserData = path.join(tmpRoot, 'gog-renew-userdata');
      fs.mkdirSync(tempHome, { recursive: true });
      fs.mkdirSync(tempUserData, { recursive: true });

      const twoHoursAgoMs = Date.now() - 2 * 3600 * 1000;
      const twoHoursAgoIso = new Date(twoHoursAgoMs).toISOString();

      // 1. Verify accurate loginTime calculation from updatedAt (when skipNetwork: true)
      const offlineRes = await launcherEngine.ensureGogdlAuthConfig({
        homedir: tempHome,
        userDataDir: tempUserData,
        skipNetwork: true,
        savedTokens: {
          gog: {
            access_token: 'expired-gog-token-123',
            refresh_token: 'valid-gog-refresh-456',
            user_id: 'gog-user-777',
            expires_in: 3600,
            updatedAt: twoHoursAgoIso,
          },
        },
      });

      const expectedAuthPath = path.join(tempUserData, 'gog_store', 'auth.json');
      expect(offlineRes.gogAuthPath).toBe(expectedAuthPath);
      expect(offlineRes.accessToken).toBe('expired-gog-token-123');

      const offlineAuthJson = JSON.parse(fs.readFileSync(expectedAuthPath, 'utf8'));
      expect(offlineAuthJson['46899977096215655'].loginTime).toBe(Math.floor(twoHoursAgoMs / 1000));

      // 2. Verify automatic token renewal when expired or forceTokenRefresh: true
      const storeSyncMod = require('../electron/storeSync.cjs');
      const renewedNowMs = Date.now();
      const renewedNowIso = new Date(renewedNowMs).toISOString();
      const origRenew = storeSyncMod.renewGogTokens;
      let capturedRefreshToken = '';

      storeSyncMod.renewGogTokens = async (rt: string) => {
        capturedRefreshToken = rt;
        return {
          access_token: 'freshly-renewed-gog-access-token',
          refresh_token: 'freshly-renewed-gog-refresh-token',
          user_id: 'gog-user-777',
          expires_in: 3600,
          updatedAt: renewedNowIso,
        };
      };

      try {
        const renewedRes = await launcherEngine.ensureGogdlAuthConfig({
          homedir: tempHome,
          userDataDir: tempUserData,
          forceTokenRefresh: true,
          savedTokens: {
            gog: {
              access_token: 'expired-gog-token-123',
              refresh_token: 'valid-gog-refresh-456',
              user_id: 'gog-user-777',
              expires_in: 3600,
              updatedAt: twoHoursAgoIso,
            },
          },
        });

        expect(capturedRefreshToken).toBe('valid-gog-refresh-456');
        expect(renewedRes.gogAuthPath).toBe(expectedAuthPath);
        expect(renewedRes.accessToken).toBe('freshly-renewed-gog-access-token');

        const renewedAuthJson = JSON.parse(fs.readFileSync(expectedAuthPath, 'utf8'));
        expect(renewedAuthJson['46899977096215655'].access_token).toBe(
          'freshly-renewed-gog-access-token'
        );
        expect(renewedAuthJson['46899977096215655'].refresh_token).toBe(
          'freshly-renewed-gog-refresh-token'
        );
        expect(renewedAuthJson['46899977096215655'].loginTime).toBe(Math.floor(renewedNowMs / 1000));
      } finally {
        storeSyncMod.renewGogTokens = origRenew;
      }
    });

    it('passes game subdirectory (--path <finalInstallPath>) to gogdl, parses size tuple, and discovers macOS .app binary', async () => {
      const tempHome = path.join(tmpRoot, 'gogdl-home');
      const gogInstallRoot = path.join(tmpRoot, 'GOG');
      const mockGogdlBin = path.join(
        tempHome,
        'Library/Application Support/heroic/tools/bin/gogdl'
      );
      const argsCaptureFile = path.join(tmpRoot, 'gogdl-args.json');

      writeTempFile(
        mockGogdlBin,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const pathIdx = args.indexOf('--path');
const targetPath = pathIdx >= 0 ? args[pathIdx + 1] : '';
fs.writeFileSync(${JSON.stringify(argsCaptureFile)}, JSON.stringify({ args, targetPath }, null, 2), 'utf8');

if (!targetPath.endsWith(path.sep + 'Beholder 2') && !targetPath.endsWith('/Beholder 2')) {
  process.stderr.write('CRITICAL: --path did not end with /Beholder 2: ' + targetPath + '\\n');
  process.exit(2);
}

process.stdout.write("(1.58, 'GB') 1696488704\\n");
process.stdout.write("Progress: 60.00\\n");

const appBin = path.join(targetPath, 'Beholder2.app', 'Contents', 'MacOS', 'Beholder2');
fs.mkdirSync(path.dirname(appBin), { recursive: true });
fs.writeFileSync(appBin, '#!/bin/sh\\necho "Beholder 2 macOS"\\n', { mode: 0o755 });

setTimeout(() => process.exit(0), 30);
`,
        0o755
      );

      const capturedUpdates: DownloadTaskState[] = [];
      const completionPromise = new Promise<DownloadTaskState>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timeout waiting for gogdl Beholder 2 install')),
          5000
        );
        const unsub = launcherEngine.onDownloadUpdated((ev: any) => {
          if (ev.task?.gameId === 'gog-1762937538') {
            capturedUpdates.push({ ...ev.task });
            if (ev.task.status === 'completed') {
              clearTimeout(timeout);
              unsub();
              resolve(ev.task);
            } else if (ev.task.status === 'failed') {
              clearTimeout(timeout);
              unsub();
              reject(new Error(ev.task.error || 'gogdl install failed'));
            }
          }
        });
      });

      await launcherEngine.installGame(
        {
          gameId: 'gog-1762937538',
          title: 'Beholder 2',
          platformId: 'gog',
          platformGameId: '1762937538',
          installDir: gogInstallRoot,
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir,
          gogAccessToken: 'mock-gog-token-beholder2',
        }
      );

      const completedTask = await completionPromise;
      const expectedSubdir = path.join(gogInstallRoot, 'Beholder 2');
      const expectedExe = path.join(
        expectedSubdir,
        'Beholder2.app',
        'Contents',
        'MacOS',
        'Beholder2'
      );

      const recordedArgs = JSON.parse(fs.readFileSync(argsCaptureFile, 'utf8'));
      expect(recordedArgs.targetPath).toBe(expectedSubdir);

      expect(capturedUpdates.some((u) => u.totalBytes === 1696488704)).toBe(true);
      expect(capturedUpdates.some((u) => u.progressPercent === 60)).toBe(true);

      expect(completedTask.status).toBe('completed');
      expect(completedTask.totalBytes).toBe(1696488704);
      expect(completedTask.finalInstallPath).toBe(expectedSubdir);
      expect(completedTask.executablePath).toBe(expectedExe);
      expect(completedTask.isWindowsBinaryOnMac).toBe(false);
    });

    it('renders GameInstallModal with single auto-detected build card vs multi-build recommended dropdown without duplicate parentheticals', async () => {
      const testGame: CanonicalGame = {
        id: 'epic-test-modal',
        title: 'Amnesia: The Dark Descent',
        sortTitle: 'Amnesia: The Dark Descent',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'ece4c58603d04bcb97454be9a7492fa6',
            installed: false,
          },
        ],
        headerImage: 'https://example.com/amnesia.jpg',
        developers: ['Frictional Games'],
        publishers: ['Frictional Games'],
        genres: ['Adventure'],
        tags: ['Horror'],
      };

      const renderStatefulModal = async (mockInstallInfo: any) => {
        const infoSpy = vi
          .spyOn(launcherService, 'getGameInstallInfo')
          .mockResolvedValue(mockInstallInfo);
        const diskSpy = vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
          targetPath: '/Users/test/Games/OneLauncher/Epic',
          freeBytes: 120 * 1024 * 1024 * 1024,
          totalBytes: 500 * 1024 * 1024 * 1024,
          usedBytes: 380 * 1024 * 1024 * 1024,
        });

        const states: any[] = [];
        const effectsRan: boolean[] = [];

        const executeRender = () => {
          let stateIdx = 0;
          let effectIdx = 0;
          const internals = (React as any)
            .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
          const prevH = internals.H;
          internals.H = {
            useState(initial: any) {
              const idx = stateIdx++;
              if (idx >= states.length) {
                states.push(typeof initial === 'function' ? initial() : initial);
              }
              const setState = (updater: any) => {
                states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
              };
              return [states[idx], setState];
            },
            useEffect(fn: () => any) {
              const idx = effectIdx++;
              if (!effectsRan[idx]) {
                effectsRan[idx] = true;
                fn();
              }
            },
            useRef(initial: any) {
              return { current: initial };
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
              game: testGame,
              initialPlatformId: 'epic',
              onClose: vi.fn(),
            });
            return renderToString(vnode);
          } finally {
            internals.H = prevH;
          }
        };

        try {
          // Initial mount triggers useEffect -> getGameInstallInfo()
          executeRender();
          await new Promise((r) => setTimeout(r, 15));
          // Re-render after state updates from resolved getGameInstallInfo promise
          return executeRender();
        } finally {
          infoSpy.mockRestore();
          diskSpy.mockRestore();
        }
      };

      // 1. Single installer (Windows-only build) -> no dropdown, renders AUTO-DETECTED • WINDOWS BUILD (CROSSOVER / WINE) card
      const singleBuildHtml = await renderStatefulModal({
        platformId: 'epic',
        platformGameId: '5b60142e120c4f2d88027595c21d4a04',
        estimatedSizeBytes: 500000000,
        defaultInstallDir: '/Users/test/Games/OneLauncher/Epic',
        availableInstallDirs: ['/Users/test/Games/OneLauncher/Epic'],
        availableInstallers: [
          {
            id: 'epic-win-compat',
            name: 'DOOM 64',
            os: 'windows',
            totalSizeBytes: 500000000,
            version: '1.0',
          },
        ],
        canDirectDownload: true,
        requiresStoreClientFallback: false,
      });

      expect(singleBuildHtml).not.toContain('aria-label="Installer Build"');
      expect(singleBuildHtml).toContain('AUTO-DETECTED • WINDOWS BUILD (CROSSOVER / WINE)');

      // 2. Two installers (mac + windows) -> renders dropdown pre-selecting mac, clean option labels, and guidance note
      const multiBuildHtml = await renderStatefulModal({
        platformId: 'epic',
        platformGameId: 'ece4c58603d04bcb97454be9a7492fa6',
        estimatedSizeBytes: 1500000000,
        defaultInstallDir: '/Users/test/Games/OneLauncher/Epic',
        availableInstallDirs: ['/Users/test/Games/OneLauncher/Epic'],
        availableInstallers: [
          {
            id: 'epic-mac-native',
            name: 'Amnesia: The Dark Descent',
            os: 'mac',
            totalSizeBytes: 1500000000,
            version: '1.5.0',
          },
          {
            id: 'epic-win-compat',
            name: 'Amnesia: The Dark Descent',
            os: 'windows',
            totalSizeBytes: 1500000000,
            version: '1.5.0',
          },
        ],
        canDirectDownload: true,
        requiresStoreClientFallback: false,
      });

      expect(multiBuildHtml).toContain('aria-label="Installer Build"');
      expect(multiBuildHtml).toContain(
        '<option value="epic-mac-native" selected="">★ Recommended: Native macOS Build (v1.5.0) • 1.4 GB</option>'
      );
      expect(multiBuildHtml).toContain(
        '<option value="epic-win-compat">Alternative: Windows Build via CrossOver / Wine (v1.5.0) • 1.4 GB</option>'
      );
      expect(multiBuildHtml).not.toContain('((v');
      expect(multiBuildHtml).not.toContain('(Native))');
      expect(multiBuildHtml).toContain(
        '✓ Recommended: Official macOS build is available and auto-selected. Only choose the Windows (CrossOver / Wine) alternative if this game is an older 32-bit Mac port'
      );
    });

    it('deduplicates multi-language GOG installers per OS and strips duplicate v prefixes (e.g. Blade of Darkness vsub29b) in getGameInstallInfo and GameInstallModal', async () => {
      const langs = ['de', 'fr', 'en', 'es', 'it', 'ru', 'zh'];

      // 1. Backend: 7 Windows language installers with version "vsub29b" -> deduplicated to 1 English installer with version "sub29b"
      const winOnlyMockProduct = {
        downloads: {
          installers: langs.map((lang, idx) => ({
            id: `bod_win_${lang}_${idx}`,
            name: 'Blade of Darkness',
            os: 'windows',
            language: lang,
            total_size: 2362232012,
            version: 'vsub29b',
          })),
        },
      };

      const winOnlyInfo = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'gog',
          platformGameId: '1696765319',
          title: 'Blade of Darkness',
        },
        {
          platform: 'darwin',
          skipNetwork: true,
          mockGogProductData: winOnlyMockProduct,
        }
      );

      expect(winOnlyInfo.availableInstallers).toHaveLength(1);
      expect(winOnlyInfo.availableInstallers[0].os).toBe('windows');
      expect(winOnlyInfo.availableInstallers[0].language).toBe('en');
      expect(winOnlyInfo.availableInstallers[0].version).toBe('sub29b');

      // 2. Backend: 7 macOS language installers + 7 Windows language installers (14 total) -> deduplicated to 2 (mac first, then windows)
      const dualOsMockProduct = {
        downloads: {
          installers: [
            ...langs.map((lang, idx) => ({
              id: `dual_win_${lang}_${idx}`,
              name: 'Dual OS Game',
              os: 'windows',
              language: lang,
              total_size: 2362232012,
              version: 'vsub29b',
            })),
            ...langs.map((lang, idx) => ({
              id: `dual_mac_${lang}_${idx}`,
              name: 'Dual OS Game',
              os: 'mac',
              language: lang,
              total_size: 2147483648,
              version: 'vsub29b',
            })),
          ],
        },
      };

      const dualOsInfo = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'gog',
          platformGameId: '1696765319',
          title: 'Dual OS Game',
        },
        {
          platform: 'darwin',
          skipNetwork: true,
          mockGogProductData: dualOsMockProduct,
        }
      );

      expect(dualOsInfo.availableInstallers).toHaveLength(2);
      expect(dualOsInfo.availableInstallers[0].os).toBe('mac');
      expect(dualOsInfo.availableInstallers[0].language).toBe('en');
      expect(dualOsInfo.availableInstallers[0].version).toBe('sub29b');
      expect(dualOsInfo.availableInstallers[1].os).toBe('windows');
      expect(dualOsInfo.availableInstallers[1].language).toBe('en');
      expect(dualOsInfo.availableInstallers[1].version).toBe('sub29b');

      // 3. Frontend GameInstallModal: verify defense-in-depth deduplication and formatVersion on raw 7-language and 14-language payloads
      const bladeGame: CanonicalGame = {
        id: 'gog-1696765319',
        title: 'Blade of Darkness',
        sortTitle: 'Blade of Darkness',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1696765319',
            installed: false,
          },
        ],
        headerImage: 'https://example.com/blade.jpg',
        developers: ['Rebel Act Studios'],
        publishers: ['SNEG'],
        genres: ['Action'],
        tags: ['Hack and Slash'],
      };

      const renderModalWithInfo = async (mockInstallInfo: any): Promise<string> => {
        const infoSpy = vi
          .spyOn(launcherService, 'getGameInstallInfo')
          .mockResolvedValue(mockInstallInfo);
        const diskSpy = vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
          targetPath: '/Users/test/Games/OneLauncher/GOG',
          freeBytes: 120 * 1024 * 1024 * 1024,
          totalBytes: 500 * 1024 * 1024 * 1024,
          usedBytes: 380 * 1024 * 1024 * 1024,
        });

        const states: any[] = [];
        const effectsRan: boolean[] = [];

        const executeRender = () => {
          let stateIdx = 0;
          let effectIdx = 0;
          const internals = (React as any)
            .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
          const prevH = internals.H;
          internals.H = {
            useState(initial: any) {
              const idx = stateIdx++;
              if (idx >= states.length) {
                states.push(typeof initial === 'function' ? initial() : initial);
              }
              const setState = (updater: any) => {
                states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
              };
              return [states[idx], setState];
            },
            useEffect(fn: () => any) {
              const idx = effectIdx++;
              if (!effectsRan[idx]) {
                effectsRan[idx] = true;
                fn();
              }
            },
            useRef(initial: any) {
              return { current: initial };
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
              game: bladeGame,
              initialPlatformId: 'gog',
              onClose: vi.fn(),
            });
            return renderToString(vnode);
          } finally {
            internals.H = prevH;
          }
        };

        try {
          executeRender();
          await new Promise((r) => setTimeout(r, 15));
          return executeRender();
        } finally {
          infoSpy.mockRestore();
          diskSpy.mockRestore();
        }
      };

      // Case A: 7 localized Windows installers with version: 'vsub29b' -> single card, (vsub29b), NO dropdown
      const sevenWinInstallersHtml = await renderModalWithInfo({
        platformId: 'gog',
        platformGameId: '1696765319',
        hostPlatform: 'darwin',
        estimatedSizeBytes: 2362232012,
        defaultInstallDir: '/Users/test/Games/OneLauncher/GOG',
        availableInstallDirs: ['/Users/test/Games/OneLauncher/GOG'],
        availableInstallers: langs.map((lang, idx) => ({
          id: `bod_win_${lang}_${idx}`,
          name: 'Blade of Darkness — Windows Build',
          os: 'windows' as const,
          language: lang,
          totalSizeBytes: 2362232012,
          version: 'vsub29b',
        })),
        canDirectDownload: true,
        requiresStoreClientFallback: false,
      });

      expect(sevenWinInstallersHtml).toContain('AUTO-DETECTED • WINDOWS BUILD (CROSSOVER / WINE)');
      expect(sevenWinInstallersHtml).toContain('(vsub29b)');
      expect(sevenWinInstallersHtml).not.toContain('vvsub29b');
      expect(sevenWinInstallersHtml).not.toContain('aria-label="Installer Build"');

      // Case B: 7 macOS language installers + 7 Windows language installers (14 total) -> dropdown with exactly 2 options
      const fourteenDualInstallersHtml = await renderModalWithInfo({
        platformId: 'gog',
        platformGameId: '1696765319',
        hostPlatform: 'darwin',
        estimatedSizeBytes: 2147483648,
        defaultInstallDir: '/Users/test/Games/OneLauncher/GOG',
        availableInstallDirs: ['/Users/test/Games/OneLauncher/GOG'],
        availableInstallers: [
          ...langs.map((lang, idx) => ({
            id: `dual_mac_${lang}_${idx}`,
            name: 'Blade of Darkness — Native macOS Build',
            os: 'mac' as const,
            language: lang,
            totalSizeBytes: 2147483648,
            version: 'vsub29b',
          })),
          ...langs.map((lang, idx) => ({
            id: `dual_win_${lang}_${idx}`,
            name: 'Blade of Darkness — Windows Build',
            os: 'windows' as const,
            language: lang,
            totalSizeBytes: 2362232012,
            version: 'vsub29b',
          })),
        ],
        canDirectDownload: true,
        requiresStoreClientFallback: false,
      });

      expect(fourteenDualInstallersHtml).toContain('aria-label="Installer Build"');
      expect(fourteenDualInstallersHtml).not.toContain('vvsub29b');
      expect(fourteenDualInstallersHtml).toContain(
        '★ Recommended: Native macOS Build (vsub29b) • 2.0 GB'
      );
      expect(fourteenDualInstallersHtml).toContain(
        'Alternative: Windows Build via CrossOver / Wine (vsub29b) • 2.2 GB'
      );

      // Extract the <select aria-label="Installer Build">...</select> block and verify it has exactly 2 <option> elements
      const selectMatch = fourteenDualInstallersHtml.match(
        /<select[^>]*aria-label="Installer Build"[^>]*>([\s\S]*?)<\/select>/
      );
      expect(selectMatch).toBeTruthy();
      const optionMatches = selectMatch![1].match(/<option\b/g) || [];
      expect(optionMatches).toHaveLength(2);
    });
  });


  // =========================================================================
  // 10. WINDOWS X64 (win32) NATIVE HOST EXPERIENCE
  // =========================================================================
  describe('10. Windows x64 (win32) Native Host Experience', () => {
    let previousElectronAPI: any;

    beforeEach(() => {
      previousElectronAPI = (globalThis as any).window?.electronAPI;
    });

    afterEach(() => {
      if (previousElectronAPI === undefined) {
        delete (globalThis as any).window.electronAPI;
      } else {
        (globalThis as any).window.electronAPI = previousElectronAPI;
      }
    });

    it('detects win32 host in LauncherService and returns exclusively Windows native installers from launcherEngine.getGameInstallInfo', async () => {
      // Default fallback in test environment is darwin
      delete (globalThis as any).window.electronAPI;
      expect(launcherService.getHostPlatform()).toBe('darwin');
      expect(launcherService.isWindowsHost()).toBe(false);

      // Simulate Windows x64 Electron preload environment
      (globalThis as any).window.electronAPI = {
        ...(previousElectronAPI || {}),
        isElectron: true,
        platform: 'win32',
      };

      expect(launcherService.getHostPlatform()).toBe('win32');
      expect(launcherService.isWindowsHost()).toBe(true);

      // Verify backend getGameInstallInfo on win32 returns hostPlatform: 'win32' and exclusively Windows native installers
      const gogInstallInfo = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'gog',
          platformGameId: '1451215361',
          title: 'Beholder 2',
        },
        {
          platform: 'win32',
          skipNetwork: true,
        }
      );

      expect(gogInstallInfo.hostPlatform).toBe('win32');
      expect(gogInstallInfo.availableInstallers.length).toBeGreaterThan(0);
      expect(gogInstallInfo.availableInstallers.every((ins: any) => ins.os === 'windows')).toBe(
        true
      );
      expect(gogInstallInfo.availableInstallers.some((ins: any) => ins.os === 'mac')).toBe(false);
      expect(gogInstallInfo.availableInstallers[0].name).toContain('Windows Native Build');
      expect(gogInstallInfo.availableInstallers[0].name).not.toMatch(/CrossOver|Wine|macOS/i);

      const epicInstallInfo = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'epic',
          platformGameId: 'ece4c58603d04bcb97454be9a7492fa6',
          title: 'Amnesia: The Dark Descent',
        },
        {
          platform: 'win32',
          skipNetwork: true,
        }
      );

      expect(epicInstallInfo.hostPlatform).toBe('win32');
      expect(epicInstallInfo.availableInstallers.length).toBe(1);
      expect(epicInstallInfo.availableInstallers[0].os).toBe('windows');
      expect(epicInstallInfo.availableInstallers[0].name).toContain('Windows Native Build');
    });

    it('renders GameInstallModal on Windows (win32) host with Windows-native method descriptions and zero macOS/Wine terminology', async () => {
      (globalThis as any).window.electronAPI = {
        ...(previousElectronAPI || {}),
        isElectron: true,
        platform: 'win32',
      };

      const testGame: CanonicalGame = {
        id: 'gog-1451215361',
        title: 'Beholder 2',
        sortTitle: 'Beholder 2',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1451215361',
            installed: false,
          },
          {
            platformId: 'epic',
            platformGameId: 'beholder-2-epic',
            installed: false,
          },
        ],
        headerImage: 'https://example.com/beholder2.jpg',
        developers: ['Warm Lamp Games'],
        publishers: ['Alawar Premium'],
        genres: ['Simulation'],
        tags: ['Dystopian'],
      };

      const renderWinInstallModal = async (
        platformId: 'gog' | 'epic',
        mockInstallInfo: any
      ): Promise<string> => {
        const infoSpy = vi
          .spyOn(launcherService, 'getGameInstallInfo')
          .mockResolvedValue(mockInstallInfo);
        const diskSpy = vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
          targetPath: 'C:\\Games\\OneLauncher',
          freeBytes: 200 * 1024 * 1024 * 1024,
          totalBytes: 500 * 1024 * 1024 * 1024,
          usedBytes: 300 * 1024 * 1024 * 1024,
        });

        const states: any[] = [];
        const effectsRan: boolean[] = [];

        const executeRender = () => {
          let stateIdx = 0;
          let effectIdx = 0;
          const internals = (React as any)
            .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
          const prevH = internals.H;
          internals.H = {
            useState(initial: any) {
              const idx = stateIdx++;
              if (idx >= states.length) {
                states.push(typeof initial === 'function' ? initial() : initial);
              }
              const setState = (updater: any) => {
                states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
              };
              return [states[idx], setState];
            },
            useEffect(fn: () => any) {
              const idx = effectIdx++;
              if (!effectsRan[idx]) {
                effectsRan[idx] = true;
                fn();
              }
            },
            useRef(initial: any) {
              return { current: initial };
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
              game: testGame,
              initialPlatformId: platformId,
              onClose: vi.fn(),
            });
            return renderToString(vnode);
          } finally {
            internals.H = prevH;
          }
        };

        try {
          executeRender();
          await new Promise((r) => setTimeout(r, 15));
          return executeRender();
        } finally {
          infoSpy.mockRestore();
          diskSpy.mockRestore();
        }
      };

      const gogWinHtml = await renderWinInstallModal('gog', {
        platformId: 'gog',
        platformGameId: '1451215361',
        hostPlatform: 'win32',
        estimatedSizeBytes: 2600 * 1024 * 1024,
        defaultInstallDir: 'C:\\Games\\OneLauncher\\GOG',
        availableInstallDirs: ['C:\\Games\\OneLauncher\\GOG', 'C:\\Games'],
        availableInstallers: [
          {
            id: 'gog-win-native',
            name: 'Beholder 2 — Windows Native Build',
            os: 'windows',
            totalSizeBytes: 2600 * 1024 * 1024,
            version: '1.1.0',
          },
        ],
        canDirectDownload: true,
        requiresStoreClientFallback: false,
      });

      expect(gogWinHtml).toContain(
        'Downloads official DRM-free Windows game files directly from GOG CDN via bundled gogdl with automatic credential bridging.'
      );
      expect(gogWinHtml).not.toMatch(/macOS|CrossOver|Whisky|Wine|GPTK/i);
      expect(gogWinHtml).not.toContain('Platform &amp; Installer Build');
      expect(gogWinHtml).not.toContain('Platform & Installer Build');

      const epicWinHtml = await renderWinInstallModal('epic', {
        platformId: 'epic',
        platformGameId: 'beholder-2-epic',
        hostPlatform: 'win32',
        estimatedSizeBytes: 2600 * 1024 * 1024,
        defaultInstallDir: 'C:\\Games\\OneLauncher\\Epic',
        availableInstallDirs: ['C:\\Games\\OneLauncher\\Epic', 'C:\\Games'],
        availableInstallers: [
          {
            id: 'epic-win-native',
            name: 'Beholder 2 (Windows Native Build)',
            os: 'windows',
            totalSizeBytes: 2600 * 1024 * 1024,
            version: '1.1.0',
          },
        ],
        canDirectDownload: true,
        requiresStoreClientFallback: false,
      });

      expect(epicWinHtml).toContain(
        'Downloads and verifies native Windows game files directly from Epic Games CDN via bundled Legendary CLI.'
      );
      expect(epicWinHtml).not.toMatch(/macOS|CrossOver|Whisky|Wine|GPTK/i);
      expect(epicWinHtml).not.toContain('Platform &amp; Installer Build');
      expect(epicWinHtml).not.toContain('Platform & Installer Build');
    });

    it('renders GameLaunchConfigModal and SteamLibraryActionBar on Windows (win32) host with direct .exe handling and zero compatibility layer UI', async () => {
      (globalThis as any).window.electronAPI = {
        ...(previousElectronAPI || {}),
        isElectron: true,
        platform: 'win32',
      };

      const winGame: CanonicalGame = {
        id: 'gog-1451215361',
        title: 'Beholder 2',
        sortTitle: 'Beholder 2',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1451215361',
            installed: true,
            installPath: 'C:\\Games\\Beholder2',
            executablePath: 'C:\\Games\\Beholder2\\Beholder2.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
        headerImage: 'https://example.com/beholder2.jpg',
        developers: ['Warm Lamp Games'],
        publishers: ['Alawar Premium'],
        genres: ['Simulation'],
        tags: ['Dystopian'],
      };

      const selectExeSpy = vi
        .spyOn(launcherService, 'selectExecutable')
        .mockResolvedValue('C:\\Games\\Beholder2\\Beholder2.exe');
      const saveConfigSpy = vi
        .spyOn(launcherService, 'saveLaunchConfig')
        .mockResolvedValue(undefined);
      const getLaunchConfigSpy = vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: winGame.id,
        preferredPlatformId: 'gog',
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover',
        wineBottleName: 'Steam',
        winePrefixPath: '/Users/test/Bottles/Steam',
      });

      // Helper to traverse React element tree and find a button matching predicate
      const findElement = (node: any, predicate: (el: any) => boolean): any => {
        if (!node || typeof node !== 'object') return null;
        if (Array.isArray(node)) {
          for (const child of node) {
            const found = findElement(child, predicate);
            if (found) return found;
          }
          return null;
        }
        if (predicate(node)) return node;
        if (node.props && node.props.children) {
          return findElement(node.props.children, predicate);
        }
        return null;
      };

      const extractText = (node: any): string => {
        if (node === null || node === undefined || typeof node === 'boolean') return '';
        if (typeof node === 'string' || typeof node === 'number') return String(node);
        if (Array.isArray(node)) return node.map(extractText).join('');
        if (node.props && node.props.children) return extractText(node.props.children);
        return '';
      };

      try {
        const states: any[] = [];
        const effectsRan: boolean[] = [];
        let savedConfigResult: GameLaunchConfig | undefined;

        const renderLaunchModal = () => {
          let stateIdx = 0;
          let effectIdx = 0;
          const internals = (React as any)
            .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
          const prevH = internals.H;
          internals.H = {
            useState(initial: any) {
              const idx = stateIdx++;
              if (idx >= states.length) {
                states.push(typeof initial === 'function' ? initial() : initial);
              }
              const setState = (updater: any) => {
                states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
              };
              return [states[idx], setState];
            },
            useEffect(fn: () => any) {
              const idx = effectIdx++;
              if (!effectsRan[idx]) {
                effectsRan[idx] = true;
                fn();
              }
            },
            useRef(initial: any) {
              return { current: initial };
            },
            useMemo(fn: () => any) {
              return fn();
            },
            useCallback(fn: any) {
              return fn;
            },
          };
          try {
            return (GameLaunchConfigModal as any)({
              isOpen: true,
              game: winGame,
              onClose: vi.fn(),
              onSaved: (cfg: GameLaunchConfig) => {
                savedConfigResult = cfg;
              },
            });
          } finally {
            internals.H = prevH;
          }
        };

        // Initial render loads existing config via useEffect
        let vnode = renderLaunchModal();
        vnode = renderLaunchModal();
        const modalHtml = renderToString(vnode);

        // Verify header title is 'Launch Settings' (not 'Launch & Compatibility Settings')
        expect(modalHtml).toContain('<h2 class="text-base font-bold text-white truncate">Launch Settings</h2>');
        expect(modalHtml).not.toContain('Launch &amp; Compatibility Settings');
        expect(modalHtml).not.toContain('Launch & Compatibility Settings');

        // Verify zero mentions of macOS / Wine / CrossOver / Whisky / GPTK / WINEPREFIX / MTL_HUD_ENABLED
        expect(modalHtml).not.toMatch(
          /CrossOver|Whisky|GPTK|macOS Compatibility Layer|WINEPREFIX|MTL_HUD_ENABLED/i
        );

        // Browse a .exe file -> sets customExecutablePath and transitions launchMethod to 'direct' (never 'compatibility_layer')
        const browseBtn = findElement(
          vnode,
          (el) =>
            el.type === 'button' && extractText(el).includes('Browse Executable...')
        );
        expect(browseBtn).toBeTruthy();
        await browseBtn.props.onClick();

        // Re-render after browsing executable
        vnode = renderLaunchModal();

        // Save configuration and verify compatibilityLayer, wineBottleName, winePrefixPath are undefined and launchMethod is 'direct'
        const saveBtn = findElement(
          vnode,
          (el) =>
            el.type === 'button' && extractText(el).includes('Save Configuration')
        );
        expect(saveBtn).toBeTruthy();
        await saveBtn.props.onClick();

        expect(saveConfigSpy).toHaveBeenCalledTimes(1);
        expect(savedConfigResult).toBeDefined();
        expect(savedConfigResult?.customExecutablePath).toBe(
          'C:\\Games\\Beholder2\\Beholder2.exe'
        );
        expect(savedConfigResult?.launchMethod).toBe('direct');
        expect(savedConfigResult?.compatibilityLayer).toBeUndefined();
        expect(savedConfigResult?.wineBottleName).toBeUndefined();
        expect(savedConfigResult?.winePrefixPath).toBeUndefined();

        // Verify SteamLibraryActionBar on Windows (win32) never displays 'CrossOver / Wine' even with a .exe executable,
        // and its Manage Game menu displays 'Launch Settings...'
        const barStates: any[] = [];
        const barEffectsRan: boolean[] = [];
        const renderActionBar = () => {
          let stateIdx = 0;
          let effectIdx = 0;
          const internals = (React as any)
            .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
          const prevH = internals.H;
          internals.H = {
            useState(initial: any) {
              const idx = stateIdx++;
              if (idx >= barStates.length) {
                barStates.push(typeof initial === 'function' ? initial() : initial);
              }
              const setState = (updater: any) => {
                barStates[idx] =
                  typeof updater === 'function' ? updater(barStates[idx]) : updater;
              };
              return [barStates[idx], setState];
            },
            useEffect(fn: () => any) {
              const idx = effectIdx++;
              if (!barEffectsRan[idx]) {
                barEffectsRan[idx] = true;
                fn();
              }
            },
            useRef(initial: any) {
              return { current: initial };
            },
            useMemo(fn: () => any) {
              return fn();
            },
            useCallback(fn: any) {
              return fn;
            },
          };
          try {
            return (SteamLibraryActionBar as any)({
              game: winGame,
            });
          } finally {
            internals.H = prevH;
          }
        };

        let barVnode = renderActionBar();
        const barClosedHtml = renderToString(barVnode);
        expect(barClosedHtml).toContain('Ready to Play');
        expect(barClosedHtml).toContain('via GOG.com');
        expect(barClosedHtml).not.toContain('CrossOver / Wine');

        // Open Manage Game menu
        const manageBtn = findElement(
          barVnode,
          (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
        );
        expect(manageBtn).toBeTruthy();
        manageBtn.props.onClick();

        barVnode = renderActionBar();
        const barOpenMenuHtml = renderToString(barVnode);
        expect(barOpenMenuHtml).toContain('Launch Settings...');
        expect(barOpenMenuHtml).not.toContain('Launch &amp; Compatibility Settings...');
        expect(barOpenMenuHtml).not.toContain('CrossOver / Wine');
      } finally {
        selectExeSpy.mockRestore();
        saveConfigSpy.mockRestore();
        getLaunchConfigSpy.mockRestore();
      }
    });

    it('verifies Windows Uninstaller packaging config, NSIS hooks, standalone uninstaller .exe/.bat/.ps1, and complete cleanup target coverage', () => {
      const repoRoot = path.resolve(__dirname, '..');

      // 1. Verify package.json NSIS uninstaller configuration
      const pkgPath = path.join(repoRoot, 'package.json');
      expect(fs.existsSync(pkgPath)).toBe(true);
      const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      expect(pkgJson.build?.nsis?.deleteAppDataOnUninstall).toBe(true);
      expect(pkgJson.build?.nsis?.include).toBe('build/installer.nsh');

      // 2. Verify all Windows uninstaller artifacts exist on disk
      const installerNshPath = path.join(repoRoot, 'build/installer.nsh');
      const standaloneNsiPath = path.join(repoRoot, 'build/standalone-uninstaller.nsi');
      const ps1ScriptPath = path.join(
        repoRoot,
        'scripts/windows-uninstaller/Uninstall-OneLauncher.ps1'
      );
      const batScriptPath = path.join(repoRoot, 'release/Uninstall One Launcher (Full Clean).bat');
      const standaloneExePath = path.join(repoRoot, 'release/One Launcher Full Uninstaller.exe');

      expect(fs.existsSync(installerNshPath)).toBe(true);
      expect(fs.existsSync(standaloneNsiPath)).toBe(true);
      expect(fs.existsSync(ps1ScriptPath)).toBe(true);
      expect(fs.existsSync(batScriptPath)).toBe(true);
      expect(fs.existsSync(standaloneExePath)).toBe(true);
      expect(fs.statSync(standaloneExePath).size).toBeGreaterThan(10000);

      const nshContent = fs.readFileSync(installerNshPath, 'utf8');
      const nsiContent = fs.readFileSync(standaloneNsiPath, 'utf8');
      const ps1Content = fs.readFileSync(ps1ScriptPath, 'utf8');
      const batContent = fs.readFileSync(batScriptPath, 'utf8');

      // Verify NSIS customUnInstall macro in build/installer.nsh
      expect(nshContent).toContain('!macro customUnInstall');
      expect(nshContent).toContain('!macroend');

      // 3. Verify coverage across installer.nsh, standalone-uninstaller.nsi, and Uninstall-OneLauncher.ps1
      for (const content of [nshContent, nsiContent]) {
        // Process termination
        expect(content).toContain('One Launcher.exe');
        expect(content).toContain('legendary.exe');
        expect(content).toContain('gogdl.exe');
      }
      expect(ps1Content).toContain('"One Launcher"');
      expect(ps1Content).toContain('"legendary"');
      expect(ps1Content).toContain('"gogdl"');
      expect(ps1Content).toContain('$procName.exe');

      for (const content of [nshContent, nsiContent, ps1Content, batContent]) {
        // Dynamic game installation manifest parsing + custom path/ID tracking
        expect(content).toContain('one_launcher_installed.json');
        expect(content).toContain('installed.json');
        expect(content).toContain('removedPaths');
        expect(content).toContain('removedIds');
        expect(content).toContain('[System.Array]');

        // Epic Games Launcher & GOG Galaxy 2.0 first-party cleanup
        expect(content).toContain('C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests');
        expect(content).toContain('C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat');
        expect(content).toContain('C:\\ProgramData\\GOG.com\\Galaxy\\config.json');
        expect(content).toContain('galaxy-2.0.db');
        expect(content).toContain('InstalledBaseProducts');
        expect(content).toContain('InstalledProducts');
        expect(content).toContain('HKCU:\\Software\\GOG.com\\Games');
        expect(content).toContain('HKLM:\\Software\\WOW6432Node\\GOG.com\\Games');

        // Default game library folders
        expect(content).toContain('C:\\Games\\OneLauncher');
        expect(content).toContain('Games\\OneLauncher');
        expect(content).toContain('OneLauncher Games');

        // Electron AppData / LocalAppData / cache / token / LevelDB directories
        expect(content).toContain('one-launcher');
        expect(content).toContain('One Launcher');
        expect(content).toContain('com.onelauncher.app');
        expect(content).toContain('one-launcher-updater');

        // Bundled CLI tool config & cache directories
        expect(content).toContain('.config\\legendary');
        expect(content).toContain('legendary');
        expect(content).toContain('.config\\gogdl');
        expect(content).toContain('gogdl');

        // Shortcuts & Registry uninstall keys
        expect(content).toContain('One Launcher.lnk');
        expect(content).toContain('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
      }
    });

    it('distinguishes 16-bit MS-DOS executables from 64-bit Windows PE binaries (Quake 2310) and launches Steam games via steam://rungameid in auto mode without spawn UNKNOWN', async () => {
      const quakeDir = path.join(tmpRoot, 'steamapps', 'common', 'Quake');
      const dosQuakeExe = path.join(quakeDir, 'quake.exe');
      const pe64QuakeExe = path.join(quakeDir, 'rerelease', 'Quake_x64_steam.exe');

      fs.mkdirSync(path.dirname(dosQuakeExe), { recursive: true });
      fs.mkdirSync(path.dirname(pe64QuakeExe), { recursive: true });

      // 1. Construct a >128-byte 16-bit MS-DOS MZ binary (e_lfanew = 0x20, no PE\0\0 header)
      const dosBuf = Buffer.alloc(160, 0);
      dosBuf[0] = 0x4d; // 'M'
      dosBuf[1] = 0x5a; // 'Z'
      dosBuf.writeUInt32LE(0x20, 0x3c); // e_lfanew < 0x40 -> 16-bit DOS stub
      fs.writeFileSync(dosQuakeExe, dosBuf);

      // 2. Construct a >200-byte 64-bit Windows PE32+ binary (MZ at 0x00, e_lfanew = 0x80 at 0x3C, 'PE\0\0' at 0x80, Machine = 0x8664 at 0x84)
      const pe64Buf = Buffer.alloc(256, 0);
      pe64Buf[0] = 0x4d; // 'M'
      pe64Buf[1] = 0x5a; // 'Z'
      pe64Buf.writeUInt32LE(0x80, 0x3c); // e_lfanew = 0x80
      pe64Buf[0x80] = 0x50; // 'P'
      pe64Buf[0x81] = 0x45; // 'E'
      pe64Buf[0x82] = 0x00; // '\0'
      pe64Buf[0x83] = 0x00; // '\0'
      pe64Buf.writeUInt16LE(0x8664, 0x84); // IMAGE_FILE_MACHINE_AMD64 (x64)
      fs.writeFileSync(pe64QuakeExe, pe64Buf);

      // Verify inspectWindowsExecutableHeader accurately classifies both binaries
      const dosHeaderInfo = launcherEngine.inspectWindowsExecutableHeader(dosQuakeExe);
      expect(dosHeaderInfo.is16BitDos).toBe(true);
      expect(dosHeaderInfo.isValidPe).toBe(false);
      expect(dosHeaderInfo.is64Bit).toBe(false);

      const pe64HeaderInfo = launcherEngine.inspectWindowsExecutableHeader(pe64QuakeExe);
      expect(pe64HeaderInfo.isValidPe).toBe(true);
      expect(pe64HeaderInfo.is64Bit).toBe(true);
      expect(pe64HeaderInfo.is16BitDos).toBe(false);
      expect(pe64HeaderInfo.machine).toBe(0x8664);

      // Verify findPrimaryExecutable skips 16-bit MS-DOS quake.exe and selects rerelease/Quake_x64_steam.exe
      const discovered = launcherEngine.findPrimaryExecutable(quakeDir, {
        platform: 'win32',
        hintName: 'Quake',
      });
      expect(discovered.executablePath).toBe(pe64QuakeExe);
      expect(discovered.isWindowsBinaryOnMac).toBe(false);

      // Verify launchGame for Steam Quake on win32 in 'auto' mode (even with stale 16-bit quake.exe path)
      // launches cleanly via steam://rungameid/2310 (storefront_uri) without throwing spawn UNKNOWN
      const openedUris: string[] = [];
      const launchRes = await launcherEngine.launchGame(
        {
          gameId: 'steam-2310',
          title: 'Quake',
          platformId: 'steam',
          platformGameId: '2310',
          steamAppId: 2310,
          installPath: quakeDir,
          executablePath: dosQuakeExe, // stale 16-bit MS-DOS path
          launchMethod: 'auto',
        },
        {
          platform: 'win32',
          userDataDir,
          disableUriPolling: true,
          onOpenExternal: async (uri: string) => {
            openedUris.push(uri);
          },
        }
      );

      try {
        expect(launchRes.success).toBe(true);
        expect(launchRes.error).toBeUndefined();
        expect(launchRes.session).toBeDefined();
        expect(launchRes.session.launchMethod).toBe('storefront_uri');
        expect(launchRes.session.executablePath).toBe(pe64QuakeExe);
        expect(openedUris).toContain('steam://rungameid/2310');
      } finally {
        await launcherEngine.stopGame('steam-2310', { homedir: tmpRoot });
      }
    });

    it('synchronizes and unregisters Epic Games Launcher (.item manifests + LauncherInstalled.dat) and GOG Galaxy 2.0 (nested dir flattening + config.json + galaxy-2.0.db SQLite)', () => {
      const tempHome = path.join(tmpRoot, 'first-party-home');
      const tempUserData = path.join(tmpRoot, 'first-party-userdata');
      fs.mkdirSync(tempHome, { recursive: true });
      fs.mkdirSync(tempUserData, { recursive: true });

      // =====================================================================
      // 1. Epic Games Launcher First-Party Sync & Unregister
      // =====================================================================
      const epicAppName = 'd9d5bf08f174402a8d1a002b2f52a08b';
      const epicGameDir = path.join(tempHome, 'Epic', '20MinutesTillDawn');
      const epicExePath = path.join(epicGameDir, 'MinutesTillDawn.exe');
      writeTempFile(epicExePath, 'MZ-fake-windows-pe-binary-payload');

      const tempEglManifestsDir = path.join(tempHome, 'ProgramData/Epic/EpicGamesLauncher/Data/Manifests');
      const tempLauncherInstalledPath = path.join(
        tempHome,
        'ProgramData/Epic/UnrealEngineLauncher/LauncherInstalled.dat'
      );

      launcherEngine.upsertManagedInstallRecord(
        {
          platformId: 'epic',
          platformGameId: epicAppName,
          title: '20 Minutes Till Dawn',
          installPath: epicGameDir,
          executablePath: epicExePath,
          installSize: 185000000,
          version: '1.0.2',
          runner: 'legendary',
        },
        tempUserData
      );

      const epicSyncRes = launcherEngine.syncEpicFirstPartyLauncher({
        homedir: tempHome,
        userDataDir: tempUserData,
        eglManifestsDir: tempEglManifestsDir,
        eglLauncherInstalledPath: tempLauncherInstalledPath,
        skipLegendaryCliSync: true,
      });

      expect(epicSyncRes.synced).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(tempEglManifestsDir)).toBe(true);

      const eglItemFiles = fs
        .readdirSync(tempEglManifestsDir)
        .filter((f) => f.toLowerCase().endsWith('.item'));
      expect(eglItemFiles.length).toBe(1);

      const parsedItem = JSON.parse(
        fs.readFileSync(path.join(tempEglManifestsDir, eglItemFiles[0]), 'utf8')
      );
      expect(parsedItem.AppName).toBe(epicAppName);
      expect(parsedItem.DisplayName).toBe('20 Minutes Till Dawn');
      expect(parsedItem.InstallLocation).toBe(epicGameDir);
      expect(parsedItem.bIsIncompleteInstall).toBe(false);

      // Verify .egstore/<GUID>.item inside installPath
      const egstoreItemPath = path.join(epicGameDir, '.egstore', eglItemFiles[0]);
      expect(fs.existsSync(egstoreItemPath)).toBe(true);

      // Verify LauncherInstalled.dat contains the entry in InstallationList
      expect(fs.existsSync(tempLauncherInstalledPath)).toBe(true);
      const parsedDat = JSON.parse(fs.readFileSync(tempLauncherInstalledPath, 'utf8'));
      expect(Array.isArray(parsedDat.InstallationList)).toBe(true);
      expect(parsedDat.InstallationList).toHaveLength(1);
      expect(parsedDat.InstallationList[0].AppName).toBe(epicAppName);
      expect(parsedDat.InstallationList[0].InstallLocation).toBe(epicGameDir);

      // Unregister Epic game and verify .item manifest and LauncherInstalled.dat entry are removed
      const epicUnregRes = launcherEngine.unregisterEpicFirstPartyLauncher(
        epicAppName,
        epicGameDir,
        {
          homedir: tempHome,
          userDataDir: tempUserData,
          eglManifestsDir: tempEglManifestsDir,
          eglLauncherInstalledPath: tempLauncherInstalledPath,
        }
      );
      expect(epicUnregRes.removed).toBe(1);
      expect(
        fs.readdirSync(tempEglManifestsDir).filter((f) => f.toLowerCase().endsWith('.item'))
      ).toHaveLength(0);
      const parsedDatAfter = JSON.parse(fs.readFileSync(tempLauncherInstalledPath, 'utf8'));
      expect(parsedDatAfter.InstallationList).toHaveLength(0);

      // =====================================================================
      // 2. GOG Galaxy 2.0 First-Party Sync & Unregister
      // =====================================================================
      const gogProductId = '1456460669';
      const gogInstallDir = path.join(tempHome, 'GOG', 'Beholder 2');
      const gogNestedDir = path.join(gogInstallDir, 'Beholder 2 Enhanced');
      writeTempFile(
        path.join(gogNestedDir, `goggame-${gogProductId}.info`),
        JSON.stringify({
          gameId: gogProductId,
          name: 'Beholder 2',
          buildId: '5544332211',
        })
      );
      writeTempFile(path.join(gogNestedDir, 'Beholder2.exe'), 'MZ-fake-windows-pe-binary-payload');

      const tempGogConfigPath = path.join(tempHome, 'ProgramData/GOG.com/Galaxy/config.json');
      writeTempFile(
        tempGogConfigPath,
        JSON.stringify({
          libraryPath: 'C:\\Program Files (x86)\\GOG Galaxy\\Games',
          installationPaths: [],
        })
      );

      const tempGalaxyDbPath = path.join(
        tempHome,
        'ProgramData/GOG.com/Galaxy/storage/galaxy-2.0.db'
      );
      fs.mkdirSync(path.dirname(tempGalaxyDbPath), { recursive: true });

      const gogSyncRes = launcherEngine.syncGogFirstPartyLauncher(
        {
          platformId: 'gog',
          platformGameId: gogProductId,
          title: 'Beholder 2',
          installPath: gogInstallDir,
          version: '1.5',
        },
        {
          homedir: tempHome,
          userDataDir: tempUserData,
          gogGalaxyConfigPath: tempGogConfigPath,
          gogGalaxyDbPath: tempGalaxyDbPath,
          skipRegistry: true,
        }
      );

      expect(gogSyncRes.synced).toBe(true);

      // Verify nested folder was flattened so goggame-1456460669.info, .goggame-1456460669.info, and Beholder2.exe are at depth 0
      expect(fs.existsSync(path.join(gogInstallDir, `goggame-${gogProductId}.info`))).toBe(true);
      expect(fs.existsSync(path.join(gogInstallDir, `.goggame-${gogProductId}.info`))).toBe(true);
      expect(fs.existsSync(path.join(gogInstallDir, 'Beholder2.exe'))).toBe(true);

      // Verify config.json includes parent library folder (<tempHome>/GOG) in installationPaths
      const updatedGogCfg = JSON.parse(fs.readFileSync(tempGogConfigPath, 'utf8'));
      expect(updatedGogCfg.installationPaths).toContain(path.join(tempHome, 'GOG'));

      // Verify SQLite galaxy-2.0.db tables contain productId = 1456460669
      const { DatabaseSync } = require('node:sqlite');
      const dbCheck1 = new DatabaseSync(tempGalaxyDbPath);
      try {
        const instProd = dbCheck1
          .prepare('SELECT productId FROM InstalledProducts WHERE productId = ?')
          .get(1456460669);
        const instBase = dbCheck1
          .prepare(
            'SELECT productId, installationPath, buildId FROM InstalledBaseProducts WHERE productId = ?'
          )
          .get(1456460669);
        const latestBuild = dbCheck1
          .prepare('SELECT productId, buildId FROM ImportedLatestBuildIds WHERE productId = ?')
          .get(1456460669);

        expect(instProd?.productId).toBe(1456460669);
        expect(instBase?.productId).toBe(1456460669);
        expect(instBase?.installationPath).toBe(gogInstallDir);
        expect(latestBuild?.productId).toBe(1456460669);
      } finally {
        dbCheck1.close();
      }

      // Unregister GOG game and verify SQLite rows are deleted
      const gogUnregRes = launcherEngine.unregisterGogFirstPartyLauncher(
        gogProductId,
        gogInstallDir,
        {
          homedir: tempHome,
          userDataDir: tempUserData,
          gogGalaxyDbPath: tempGalaxyDbPath,
          skipRegistry: true,
        }
      );
      expect(gogUnregRes.removed).toBe(true);

      const dbCheck2 = new DatabaseSync(tempGalaxyDbPath);
      try {
        const remProd = dbCheck2
          .prepare('SELECT COUNT(*) AS cnt FROM InstalledProducts WHERE productId = ?')
          .get(1456460669);
        const remBase = dbCheck2
          .prepare('SELECT COUNT(*) AS cnt FROM InstalledBaseProducts WHERE productId = ?')
          .get(1456460669);
        expect(remProd?.cnt).toBe(0);
        expect(remBase?.cnt).toBe(0);
      } finally {
        dbCheck2.close();
      }
    });

    it('enforces strictly monotonic progressPercent across split gogdl stderr chunks and updateDownloadTask calls', async () => {
      // 1. Direct unit test of launcherEngine.updateDownloadTask monotonic clamping
      const initRes = await launcherEngine.installGame(
        {
          gameId: 'gog-monotonic-unit',
          title: 'Monotonic Unit Game',
          platformId: 'gog',
          platformGameId: 'monotonic-unit-id',
          installDir: tmpRoot,
          totalBytes: 1572864000, // 1500 MB uncompressed disk size
          manualControl: true,
        },
        { userDataDir }
      );
      const directTaskId = initRes.task.taskId;

      try {
        const at45 = launcherEngine.updateDownloadTask(
          directTaskId,
          {
            status: 'downloading',
            progressPercent: 45,
            bytesDownloaded: 325058560,
            totalBytes: 1572864000,
            downloadSizeBytes: 838860800,
            speedBytesPerSec: 25000000,
            etaSeconds: 12,
          },
          { userDataDir }
        );
        expect(at45.task.progressPercent).toBe(45);

        // Update with only bytesDownloaded (no progressPercent) — must NOT recompute 325MB / 1500MB = 20%
        const afterBytesOnly = launcherEngine.updateDownloadTask(
          directTaskId,
          {
            bytesDownloaded: 325582848,
            speedBytesPerSec: 29884416,
          },
          { userDataDir }
        );
        expect(afterBytesOnly.task.progressPercent).toBe(45);

        // Update with a lower explicit progressPercent (e.g., 20% or 39%) while still downloading — must clamp to 45%
        const afterLowerPercent = launcherEngine.updateDownloadTask(
          directTaskId,
          {
            progressPercent: 20,
          },
          { userDataDir }
        );
        expect(afterLowerPercent.task.progressPercent).toBe(45);

        // Update with a higher explicit progressPercent (48%) — must advance to 48%
        const afterHigherPercent = launcherEngine.updateDownloadTask(
          directTaskId,
          {
            progressPercent: 48,
          },
          { userDataDir }
        );
        expect(afterHigherPercent.task.progressPercent).toBe(48);
      } finally {
        launcherEngine.cancelDownload(directTaskId);
      }

      // 2. End-to-end multi-chunk gogdl installation stderr stream test
      const tempHome = path.join(tmpRoot, 'gogdl-monotonic-home');
      const gogInstallRoot = path.join(tmpRoot, 'GOGMonotonic');
      const mockGogdlBin = path.join(
        tempHome,
        'Library/Application Support/heroic/tools/bin/gogdl'
      );

      writeTempFile(
        mockGogdlBin,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const pathIdx = args.indexOf('--path');
const targetPath = pathIdx >= 0 ? args[pathIdx + 1] : '';

const appBin = path.join(targetPath, 'MonotonicGame.app', 'Contents', 'MacOS', 'MonotonicGame');
fs.mkdirSync(path.dirname(appBin), { recursive: true });
fs.writeFileSync(appBin, '#!/bin/sh\\necho "MonotonicGame"\\n', { mode: 0o755 });

// Chunk 1: Size headers + Progress: 45.20
process.stderr.write(
  "Download size: (800.0, 'MB') 838860800\\n" +
  "Disk size: (1500.0, 'MB') 1572864000\\n" +
  "= Progress: 45.20 (452/1000), Running for 00:00:10, ETA: 00:00:12\\n"
);

// Chunk 2 (50ms later, WITHOUT a Progress: line!): Downloaded MiB + speed
setTimeout(() => {
  process.stderr.write(
    " - Downloaded: 310.50 MiB, Written: 450.20 MiB\\n" +
    " + Download\\t- 28.50 MiB/s (raw)\\n"
  );
}, 50);

// Chunk 3 (100ms later): Progress: 48.00 + Downloaded MiB
setTimeout(() => {
  process.stderr.write(
    "= Progress: 48.00 (480/1000), Running for 00:00:11, ETA: 00:00:10\\n" +
    " - Downloaded: 384.00 MiB\\n"
  );
}, 100);

setTimeout(() => process.exit(0), 150);
`,
        0o755
      );

      const history: number[] = [];
      const capturedTasks: DownloadTaskState[] = [];
      const completionPromise = new Promise<DownloadTaskState>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timeout waiting for monotonic gogdl install')),
          5000
        );
        const unsub = launcherEngine.onDownloadUpdated((ev: any) => {
          if (ev.task?.gameId === 'gog-999888777') {
            history.push(ev.task.progressPercent);
            capturedTasks.push({ ...ev.task });
            if (ev.task.status === 'completed') {
              clearTimeout(timeout);
              unsub();
              resolve(ev.task);
            } else if (ev.task.status === 'failed') {
              clearTimeout(timeout);
              unsub();
              reject(new Error(ev.task.error || 'gogdl monotonic install failed'));
            }
          }
        });
      });

      await launcherEngine.installGame(
        {
          gameId: 'gog-999888777',
          title: 'Monotonic Game',
          platformId: 'gog',
          platformGameId: '999888777',
          installDir: gogInstallRoot,
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir,
          gogAccessToken: 'mock-gog-token-monotonic',
        }
      );

      const completedTask = await completionPromise;
      expect(completedTask.status).toBe('completed');

      // Verify Download size (800 MB = 838860800) is preserved as totalBytes and not overwritten by Disk size (1500 MB)
      expect(completedTask.totalBytes).toBe(838860800);

      // Verify progress history contains 45, 48, 100 and NEVER dips backward to 20% or 39%
      expect(history).toContain(45);
      expect(history).toContain(48);
      expect(history[history.length - 1]).toBe(100);
      expect(history).not.toContain(20);
      expect(history).not.toContain(39);

      for (let i = 1; i < history.length; i++) {
        expect(history[i]).toBeGreaterThanOrEqual(history[i - 1]);
      }
    });

    it('completes scanAllInstalledGames in < 500ms without blocking subprocesses and caches findPrimaryExecutable until invalidateScanCaches()', () => {
      const tempHome = path.join(tmpRoot, 'perf-scan-home');
      const tempUserData = path.join(tmpRoot, 'perf-scan-userdata');
      const gogGameDir = path.join(tempHome, 'Games', 'GOG', 'Cyberpunk 2077');
      const exePath = path.join(gogGameDir, 'bin', 'x64', 'Cyberpunk2077.exe');
      writeTempFile(exePath, 'MZ-fake-windows-pe-binary-payload', 0o755);

      launcherEngine.upsertManagedInstallRecord(
        {
          platformId: 'gog',
          platformGameId: '1423049311',
          title: 'Cyberpunk 2077',
          installPath: gogGameDir,
          executablePath: exePath,
        },
        tempUserData
      );

      launcherEngine.invalidateScanCaches();

      const t0 = performance.now();
      const scanRes = launcherEngine.scanAllInstalledGames({
        platform: 'win32',
        homedir: tempHome,
        userDataDir: tempUserData,
        skipRegistry: true,
      });
      const elapsedMs = performance.now() - t0;

      expect(scanRes.success).toBe(true);
      expect(elapsedMs).toBeLessThan(500);
      expect(scanRes.installedGames.some((g: any) => g.platformGameId === '1423049311')).toBe(true);

      // Verify findPrimaryExecutable caching and invalidateScanCaches()
      launcherEngine.invalidateScanCaches();
      const readdirSpy = vi.spyOn(fs, 'readdirSync');
      try {
        const firstDiscovery = launcherEngine.findPrimaryExecutable(gogGameDir, {
          platform: 'win32',
          hintName: 'Cyberpunk 2077',
        });
        expect(firstDiscovery.executablePath).toBe(exePath);
        const callsAfterFirst = readdirSpy.mock.calls.length;
        expect(callsAfterFirst).toBeGreaterThan(0);

        // Second call on unchanged directory should hit executableDiscoveryCache with 0 new readdirSync calls
        const secondDiscovery = launcherEngine.findPrimaryExecutable(gogGameDir, {
          platform: 'win32',
          hintName: 'Cyberpunk 2077',
        });
        expect(secondDiscovery.executablePath).toBe(exePath);
        expect(readdirSpy.mock.calls.length).toBe(callsAfterFirst);

        // Calling invalidateScanCaches() clears executableDiscoveryCache so next call walks directory again
        launcherEngine.invalidateScanCaches();
        const thirdDiscovery = launcherEngine.findPrimaryExecutable(gogGameDir, {
          platform: 'win32',
          hintName: 'Cyberpunk 2077',
        });
        expect(thirdDiscovery.executablePath).toBe(exePath);
        expect(readdirSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it('coalesces concurrent and cooldown-window launcherService.scanAllInstalledGames calls and honors forceRefresh', async () => {
      const mockRecord: InstalledGameRecord = {
        platformId: 'steam',
        platformGameId: '1091500',
        appId: 1091500,
        title: 'Cyberpunk 2077',
        installPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077',
        executablePath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe',
        isWindowsBinaryOnMac: false,
      };

      const scanIpcSpy = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  success: true,
                  installedGames: [mockRecord],
                }),
              25
            )
          )
      );

      (globalThis as any).window.electronAPI = {
        isElectron: true,
        platform: 'win32',
        scanAllInstalledGames: scanIpcSpy,
        getRunningGames: async () => ({ success: true, runningGames: [] }),
        getDownloadQueue: async () => ({ success: true, queue: [] }),
        getGameLaunchConfigs: async () => ({ success: true, configs: {} }),
        detectCompatibilityLayers: async () => ({ success: true, layers: [] }),
      };

      const svc = new LauncherService();

      // 1. Two concurrent calls coalesce into a single IPC invocation
      const [res1, res2] = await Promise.all([
        svc.scanAllInstalledGames(),
        svc.scanAllInstalledGames(),
      ]);
      expect(scanIpcSpy).toHaveBeenCalledTimes(1);
      expect(res1).toHaveLength(1);
      expect(res2).toHaveLength(1);

      // 2. Immediate follow-up call within 1.5s cooldown returns cached records without invoking IPC
      const res3 = await svc.scanAllInstalledGames(false);
      expect(scanIpcSpy).toHaveBeenCalledTimes(1);
      expect(res3).toHaveLength(1);

      // 3. Explicit forceRefresh=true bypasses cooldown and invokes IPC a second time
      const res4 = await svc.scanAllInstalledGames(true);
      expect(scanIpcSpy).toHaveBeenCalledTimes(2);
      expect(res4).toHaveLength(1);
    });

    it('memoizes loadUserOverrides() in memory with 0 JSON.parse calls across 100 reads and invalidates on removeUserOverride', () => {
      saveUserOverride({
        gameId: 'perf-test-1',
        title: 'Perf Test',
      });

      // Prime memoized cache on initial read
      const initialMap = loadUserOverrides();
      expect(initialMap['perf-test-1']?.title).toBe('Perf Test');

      const parseSpy = vi.spyOn(JSON, 'parse');
      try {
        for (let i = 0; i < 100; i++) {
          const map = loadUserOverrides();
          expect(map['perf-test-1']?.title).toBe('Perf Test');
        }
        expect(parseSpy).toHaveBeenCalledTimes(0);
      } finally {
        parseSpy.mockRestore();
      }

      removeUserOverride('perf-test-1');
      const updatedMap = loadUserOverrides();
      expect(updatedMap['perf-test-1']).toBeUndefined();
    });
  });
});






