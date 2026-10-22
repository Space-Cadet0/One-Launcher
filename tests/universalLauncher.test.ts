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
import { SteamStorePage } from '../src/components/SteamStoreDetail/SteamStorePage';
import { DownloadManagerDrawer } from '../src/components/Launcher/DownloadManagerDrawer';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import {
  getNativeOsPlatforms,
  getStorefrontNativeOsPlatforms,
  isNativelyAvailableOnMac,
} from '../src/services/platform/nativeOsService';

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
  describe('2. Compatibility Layer Detection on macOS (CrossOver, CrossOver Preview, GPTK, Wine)', () => {
    it('detects simulated CrossOver.app with bottles, CrossOver Preview.app, game-porting-toolkit, and Wine on darwin while ignoring discontinued Whisky', () => {
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

      // 2. CrossOver Preview.app + Bottles
      const crossoverPreviewWineBin = path.join(
        macHome,
        'Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'
      );
      writeTempFile(crossoverPreviewWineBin, '#!/bin/sh\necho "CrossOver Preview Wine"\n', 0o755);
      fs.mkdirSync(
        path.join(macHome, 'Library/Application Support/CrossOver Preview/Bottles/PreviewBottle'),
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

      const crossoverPreview = layers.find((l) => l.type === 'crossover_preview');
      expect(crossoverPreview).toBeDefined();
      expect(crossoverPreview?.binaryPath).toBe(crossoverPreviewWineBin);
      expect(crossoverPreview?.availableBottles).toContain('PreviewBottle');

      const gptk = layers.find((l) => l.type === 'gptk');
      expect(gptk).toBeDefined();
      expect(gptk?.binaryPath).toBe(gptkWineBin);

      // Verify discontinued Whisky is never returned as a compatibility layer
      expect(layers.find((l) => (l as any).type === 'whisky')).toBeUndefined();

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

    it('renders SteamLibraryActionBar and SteamStorePage header across Install, Installing, Play (Steam/GOG/Epic), CrossOver/Wine, and Running states', async () => {
      // 1. Uninstalled Multi-Storefront Game -> shows Install button + Storefront Switcher (and omits redundant In Library)
      const uninstalledHtml = renderToString(
        React.createElement(SteamLibraryActionBar, {
          game: multiStoreGame,
        })
      );
      expect(uninstalledHtml).toContain('Install');
      expect(uninstalledHtml).not.toContain('In Library');
      expect(uninstalledHtml).not.toContain('Ready to Play');
      expect(uninstalledHtml).toContain('Target Storefront');
      expect(uninstalledHtml).toContain('Steam');
      expect(uninstalledHtml).toContain('GOG.com');
      expect(uninstalledHtml).toContain('Epic Games');

      const uninstalledPageHtml = renderToString(
        React.createElement(SteamStorePage, {
          game: multiStoreGame,
        })
      );
      expect(uninstalledPageHtml).toContain('Owned on:');
      expect(uninstalledPageHtml).not.toContain('In Library');
      expect(uninstalledPageHtml).not.toContain('Ready to Play');

      // 2. Installed Game on GOG -> ActionBar shows Play button; SteamStorePage header shows Ready to Play • GOG.com near Owned on:
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
      expect(installedHtml).not.toContain('Ready to Play');
      expect(installedHtml).toContain('50.0 GB');

      const installedPageHtml = renderToString(
        React.createElement(SteamStorePage, {
          game: installedGogGame,
        })
      );
      expect(installedPageHtml).toContain('Ready to Play');
      expect(installedPageHtml).toContain('GOG.com');
      expect(installedPageHtml).toContain('Owned on:');

      // 3. Installed Windows Binary on macOS -> SteamStorePage header shows CrossOver / Wine badge
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
      expect(winOnMacHtml).not.toContain('Ready to Play');

      const winOnMacPageHtml = renderToString(
        React.createElement(SteamStorePage, {
          game: winOnMacGame,
        })
      );
      expect(winOnMacPageHtml).toContain('Ready to Play');
      expect(winOnMacPageHtml).toContain('CrossOver / Wine (Epic Games)');

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
      ).replace(/<!--\s*-->/g, '');
      expect(drawerHtml).toContain('Downloads');
      expect(drawerHtml).toContain('1 Active');
      expect(drawerHtml).toContain('The Witcher 3: Wild Hunt');
      expect(drawerHtml).toContain('Downloading');

      // Cancel download so we can test Running state
      const activeTask = launcherService.getActiveDownload(multiStoreGame.id);
      if (activeTask) {
        await launcherService.cancelDownload(activeTask.taskId);
      }
      launcherService.clearCompletedDownloads();

      // 5. Running state on singleton launcherService -> ActionBar shows Running + Stop button; SteamStorePage header shows Active Session
      await launcherService.launchGame(installedGogGame, 'gog');
      const runningHtml = renderToString(
        React.createElement(SteamLibraryActionBar, {
          game: installedGogGame,
        })
      );
      expect(runningHtml).toContain('Running');
      expect(runningHtml).toContain('Stop');
      expect(runningHtml).not.toContain('Active Session');

      const runningPageHtml = renderToString(
        React.createElement(SteamStorePage, {
          game: installedGogGame,
        })
      );
      expect(runningPageHtml).toContain('Active Session');

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
      expect(configModalHtml).toContain('Pre-Configure Compatibility Runner &amp; Bottle');
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
      expect(crossoverEnv.WINEESYNC).toBe('0');
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
      expect(gptkEnv.WINEESYNC).toBe('0');
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
      expect(afterInstallClosed.html).not.toContain('Ready to Play');

      const afterInstallPageHtml = renderToString(
        React.createElement(SteamStorePage, {
          game: testGame,
        })
      );
      expect(afterInstallPageHtml).toContain('Ready to Play');

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
        expect(barClosedHtml).toContain('Play');
        expect(barClosedHtml).not.toContain('Ready to Play');
        expect(barClosedHtml).not.toContain('CrossOver / Wine');

        const winPageHtml = renderToString(
          React.createElement(SteamStorePage, {
            game: winGame,
          })
        );
        expect(winPageHtml).toContain('Ready to Play');
        expect(winPageHtml).toContain('GOG.com');
        expect(winPageHtml).not.toContain('CrossOver / Wine');

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

      // 1. Verify package.json NSIS uninstaller configuration (deleteAppDataOnUninstall: false for upgrade safety; customUnInstall handles explicit uninstall purge)
      const pkgPath = path.join(repoRoot, 'package.json');
      expect(fs.existsSync(pkgPath)).toBe(true);
      const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      expect(pkgJson.build?.nsis?.deleteAppDataOnUninstall).toBe(false);
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

      // Verify .egstore/<GUID>.mancpn inside installPath
      const itemGuid = parsedItem.InstallationGuid;
      const egstoreMancpnPath = path.join(epicGameDir, '.egstore', `${itemGuid}.mancpn`);
      expect(fs.existsSync(egstoreMancpnPath)).toBe(true);
      const parsedMancpn = JSON.parse(fs.readFileSync(egstoreMancpnPath, 'utf8'));
      expect(parsedMancpn.FormatVersion).toBe(0);
      expect(parsedMancpn.AppName).toBe(epicAppName);

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

    it('Issue 1 & 2: parses storage requirements accurately without mistaking RAM for disk space and never renders hardcoded 65 GB / 15 GB in SteamLibraryActionBar', () => {
      // 1. Steam HTML with Memory + Storage
      const steamHtml =
        '<strong>Minimum:</strong><br><ul class="bb_ul"><li><strong>Memory:</strong> 8 GB RAM<br></li><li><strong>Storage:</strong> 24.5 GB available space</li></ul>';
      expect(launcherEngine.parseStorageRequirementBytes(steamHtml)).toBe(
        Math.round(24.5 * 1024 ** 3)
      );

      // 2. GOG description text with Memory + Hard Drive Space
      const gogText = 'Memory: 4 GB RAM, Hard Drive Space: 600 MB free disk space';
      expect(launcherEngine.parseStorageRequirementBytes(gogText)).toBe(600 * 1024 ** 2);

      // 3. Text with ONLY RAM -> undefined (must not mistake 16 GB RAM for storage)
      expect(launcherEngine.parseStorageRequirementBytes('Memory: 16 GB RAM')).toBeUndefined();

      // 4. SteamLibraryActionBar rendering for an uninstalled game with no installSize and no storage requirement in metadata
      const uninstalledGame: CanonicalGame = {
        id: 'steam-999111',
        title: 'Mystery Indie RPG',
        sortTitle: 'Mystery Indie RPG',
        steamAppId: 999111,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '999111',
            installed: false,
          },
        ],
        headerImage: 'https://example.com/mystery.jpg',
        developers: ['Indie Dev'],
        publishers: ['Indie Pub'],
        genres: ['RPG', 'Action'],
        tags: ['Open World', 'RPG', 'Action'],
      };

      const states: any[] = [];
      const renderActionBar = () => {
        let stateIdx = 0;
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
          useEffect() {},
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
            game: uninstalledGame,
            metadata: {
              appId: 999111,
              name: 'Mystery Indie RPG',
              systemRequirements: {
                minimum: 'Memory: 16 GB RAM',
              },
            },
          });
        } finally {
          internals.H = prevH;
        }
      };

      const html = renderToString(renderActionBar()).replace(/<!--\s*-->/g, '');
      expect(html).toContain('Space Required');
      expect(html).toContain('—');
      expect(html).not.toContain('65 GB');
      expect(html).not.toContain('15 GB');
    });

    it('Issue 3: initializes real download tasks with speedBytesPerSec: 0, etaSeconds: undefined, and real/zero totalBytes instead of fake 120.0 MB / 18.0 MB/s', async () => {
      // Case A: Real download with estimatedSizeBytes provided
      const resWithEstimate = await launcherEngine.installGame(
        {
          gameId: 'steam-1091500',
          title: 'Cyberpunk 2077',
          platformId: 'steam',
          platformGameId: '1091500',
          steamAppId: 1091500,
          estimatedSizeBytes: 500000000,
        },
        {
          platform: 'darwin',
          homedir: path.join(tmpRoot, 'real-dl-home-a'),
          userDataDir,
          disableSteamMonitor: true,
        }
      );

      expect(resWithEstimate.success).toBe(true);
      expect(resWithEstimate.task.speedBytesPerSec).toBe(0);
      expect(resWithEstimate.task.etaSeconds).toBeUndefined();
      expect(resWithEstimate.task.totalBytes).toBe(500000000);
      expect(resWithEstimate.task.totalBytes).not.toBe(125829120);
      launcherEngine.cancelDownload(resWithEstimate.task.taskId);

      // Case B: Real download with no estimatedSizeBytes provided
      const resWithoutEstimate = await launcherEngine.installGame(
        {
          gameId: 'steam-1145360',
          title: 'Hades',
          platformId: 'steam',
          platformGameId: '1145360',
          steamAppId: 1145360,
        },
        {
          platform: 'darwin',
          homedir: path.join(tmpRoot, 'real-dl-home-b'),
          userDataDir,
          disableSteamMonitor: true,
        }
      );

      expect(resWithoutEstimate.success).toBe(true);
      expect(resWithoutEstimate.task.speedBytesPerSec).toBe(0);
      expect(resWithoutEstimate.task.etaSeconds).toBeUndefined();
      expect(resWithoutEstimate.task.totalBytes).toBe(0);
      expect(resWithoutEstimate.task.totalBytes).not.toBe(125829120);
      launcherEngine.cancelDownload(resWithoutEstimate.task.taskId);
    });

    it('Issue 6: repairs flattened macOS GOG bundles into Contents/, preserves Contents/ on re-flatten, restores +x permissions, and selects inner game binary over GOGLauncher', () => {
      const tempInstallDir = path.join(tmpRoot, 'GOG-Flattened-Mac-Bundle', 'TestGame');

      // Simulate broken/flattened macOS GOG bundle at root of install dir with 0o644 permissions
      writeTempFile(
        path.join(tempInstallDir, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>GOGLauncher</string></dict></plist>`,
        0o644
      );
      writeTempFile(path.join(tempInstallDir, 'PkgInfo'), 'APPL????', 0o644);
      writeTempFile(
        path.join(tempInstallDir, 'MacOS', 'GOGLauncher'),
        '#!/bin/sh\necho "GOGLauncher wrapper"\n',
        0o644
      );
      writeTempFile(
        path.join(
          tempInstallDir,
          'Resources',
          'game',
          'TestGame.app',
          'Contents',
          'Info.plist'
        ),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>TestGame_64</string></dict></plist>`,
        0o644
      );
      writeTempFile(
        path.join(
          tempInstallDir,
          'Resources',
          'game',
          'TestGame.app',
          'Contents',
          'MacOS',
          'TestGame_64'
        ),
        '#!/bin/sh\necho "Real TestGame_64 binary"\n',
        0o644
      );

      // 1. Repair via flattenGogNestedInstallDir and restore +x permissions via ensureMacExecutablePermissions
      launcherEngine.flattenGogNestedInstallDir(tempInstallDir, '1234567890');
      launcherEngine.ensureMacExecutablePermissions(tempInstallDir);

      const restoredPlist = path.join(tempInstallDir, 'Contents', 'Info.plist');
      const restoredLauncher = path.join(tempInstallDir, 'Contents', 'MacOS', 'GOGLauncher');
      const restoredGameBin = path.join(
        tempInstallDir,
        'Contents',
        'Resources',
        'game',
        'TestGame.app',
        'Contents',
        'MacOS',
        'TestGame_64'
      );

      expect(fs.existsSync(restoredPlist)).toBe(true);
      expect(fs.existsSync(restoredLauncher)).toBe(true);
      expect(fs.existsSync(restoredGameBin)).toBe(true);
      expect(fs.existsSync(path.join(tempInstallDir, 'Info.plist'))).toBe(false);

      // 2. Subsequent call to flattenGogNestedInstallDir must NOT flatten Contents/
      launcherEngine.flattenGogNestedInstallDir(tempInstallDir, '1234567890');
      expect(fs.existsSync(restoredPlist)).toBe(true);
      expect(fs.existsSync(restoredLauncher)).toBe(true);
      expect(fs.existsSync(restoredGameBin)).toBe(true);

      // 3. Both binaries must have executable (+x) permissions on POSIX filesystems
      if (process.platform !== 'win32') {
        expect((fs.statSync(restoredLauncher).mode & 0o111) !== 0).toBe(true);
        expect((fs.statSync(restoredGameBin).mode & 0o111) !== 0).toBe(true);
      }

      // 4. findPrimaryExecutable must select inner TestGame_64 binary over GOGLauncher wrapper
      launcherEngine.invalidateScanCaches();
      const discovery = launcherEngine.findPrimaryExecutable(tempInstallDir, {
        platform: 'darwin',
        hintName: 'TestGame',
      });
      expect(discovery.executablePath).toBe(restoredGameBin);
    });

    it('Test A: syncGogFirstPartyLauncher registers macOS .app bundle path, legacy_build_id for generation 1, branch = NULL, ProductStates (3, 0), and unwrapped inner PlayTasks executable', () => {
      const { DatabaseSync } = require('node:sqlite');
      const tempDir = path.join(tmpRoot, 'GOG-Galaxy-Mac-V1');
      const tempHome = path.join(tempDir, 'home');
      const tempUserData = path.join(tempDir, 'userdata');
      const mockDbPath = path.join(tempDir, 'galaxy-2.0.db');
      const mockConfigPath = path.join(tempDir, 'config.json');

      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(
        mockConfigPath,
        JSON.stringify({ libraryPath: '/Users/Shared/GOG.com/Galaxy/Games', installationPaths: [] }),
        'utf8'
      );

      // Seed Builds table with generation: 1 and legacy_build_id: '23581250'
      const seedDb = new DatabaseSync(mockDbPath);
      seedDb.exec(
        'CREATE TABLE IF NOT EXISTS Builds (productId INTEGER, buildId INTEGER, generation INTEGER, manifest TEXT);'
      );
      seedDb
        .prepare('INSERT INTO Builds (productId, buildId, generation, manifest) VALUES (?, ?, ?, ?)')
        .run(
          1207664543,
          12511,
          1,
          JSON.stringify({
            items: [{ build_id: '12511', legacy_build_id: '23581250', generation: 1 }],
          })
        );
      seedDb.close();

      // Create <tempDir>/Ascendant/Ascendant.app with GOGLauncher wrapper and inner Ascendant_64 64-bit Mach-O binary
      const ascendantInstallDir = path.join(tempDir, 'Ascendant');
      const outerAppPath = path.join(ascendantInstallDir, 'Ascendant.app');
      const outerLauncherBin = path.join(outerAppPath, 'Contents', 'MacOS', 'GOGLauncher');
      const innerGameBin = path.join(
        outerAppPath,
        'Contents',
        'Resources',
        'game',
        'Ascendant.app',
        'Contents',
        'MacOS',
        'Ascendant_64'
      );

      writeTempFile(
        path.join(outerAppPath, 'Contents', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>GOGLauncher</string></dict></plist>`,
        0o644
      );
      writeTempFile(outerLauncherBin, '#!/bin/sh\necho "GOGLauncher"\n', 0o755);
      writeTempFile(
        path.join(
          outerAppPath,
          'Contents',
          'Resources',
          'game',
          'Ascendant.app',
          'Contents',
          'Info.plist'
        ),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Ascendant_64</string></dict></plist>`,
        0o644
      );

      // Write 64-bit Mach-O header (0xfeedfacf LE = [0xcf, 0xfa, 0xed, 0xfe])
      fs.mkdirSync(path.dirname(innerGameBin), { recursive: true });
      const machO64Buf = Buffer.alloc(64);
      machO64Buf.writeUInt32LE(0xfeedfacf, 0);
      fs.writeFileSync(innerGameBin, machO64Buf, { mode: 0o755 });

      const syncRes = launcherEngine.syncGogFirstPartyLauncher(
        {
          platformId: 'gog',
          platformGameId: '1207664543',
          title: 'Ascendant',
          installPath: ascendantInstallDir,
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir: tempUserData,
          gogGalaxyDbPath: mockDbPath,
          gogGalaxyConfigPath: mockConfigPath,
        }
      );

      expect(syncRes.synced).toBe(true);

      const verifyDb = new DatabaseSync(mockDbPath);
      try {
        const ibp = verifyDb
          .prepare('SELECT * FROM InstalledBaseProducts WHERE productId = ?')
          .get(1207664543);
        expect(ibp).toBeTruthy();
        expect(ibp.installationPath).toBe(outerAppPath);
        expect(Number(ibp.generation)).toBe(1);
        expect(Number(ibp.buildId)).toBe(23581250);
        expect(ibp.branch).toBeNull();

        const bmt = verifyDb
          .prepare('SELECT * FROM BaseModificationTargets WHERE productId = ?')
          .get(1207664543);
        expect(bmt).toBeTruthy();
        expect(bmt.installationPath).toBe(outerAppPath);
        expect(Number(bmt.buildId)).toBe(23581250);
        expect(bmt.branch).toBeNull();

        const ps = verifyDb
          .prepare('SELECT * FROM ProductStates WHERE productId = ?')
          .get(1207664543);
        expect(ps).toBeTruthy();
        expect(Number(ps.installation)).toBe(3);
        expect(Number(ps.operation)).toBe(0);

        const pt = verifyDb
          .prepare(
            'SELECT ptlp.executablePath FROM PlayTasks pt JOIN PlayTaskLaunchParameters ptlp ON pt.id = ptlp.playTaskId WHERE pt.gameReleaseKey = ?'
          )
          .get('gog_1207664543');
        expect(pt).toBeTruthy();
        expect(pt.executablePath).toBe(innerGameBin);

        const pSettings = verifyDb
          .prepare('SELECT * FROM ProductSettings WHERE gameReleaseKey = ?')
          .get('gog_1207664543');
        expect(pSettings).toBeTruthy();
        expect(pSettings.gameReleaseKey).toBe('gog_1207664543');
      } finally {
        verifyDb.close();
      }
    });

    it('Test B: inspectMacMachOHeader & findPrimaryExecutable detect 32-bit i386 Mach-O binaries and fall back to playable Windows .exe on macOS while preferring 64-bit Mach-O when available', () => {
      const mockInstallDir = path.join(tmpRoot, 'Another-World-Dual-Dir');
      const macAppBin = path.join(
        mockInstallDir,
        'Another World.app',
        'Contents',
        'MacOS',
        'Another World'
      );
      const winExePath = path.join(mockInstallDir, 'anowor.exe');

      writeTempFile(
        path.join(mockInstallDir, 'Another World.app', 'Contents', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Another World</string></dict></plist>`,
        0o644
      );

      // 1. Write 32-bit i386 Mach-O header (0xfeedface LE = [0xce, 0xfa, 0xed, 0xfe])
      fs.mkdirSync(path.dirname(macAppBin), { recursive: true });
      const machO32Buf = Buffer.alloc(64);
      machO32Buf.writeUInt32LE(0xfeedface, 0);
      fs.writeFileSync(macAppBin, machO32Buf, { mode: 0o755 });

      // Write playable Windows PE stub (< 64 bytes synthetic stub or valid PE)
      writeTempFile(winExePath, 'MZ-valid-windows-pe-binary-stub', 0o755);

      const header32 = launcherEngine.inspectMacMachOHeader(macAppBin);
      expect(header32).toEqual({
        isMachO: true,
        is64Bit: false,
        is32BitOnly: true,
      });

      launcherEngine.invalidateScanCaches();
      const discovery32 = launcherEngine.findPrimaryExecutable(mockInstallDir, {
        platform: 'darwin',
        hintName: 'Another World',
      });
      expect(discovery32.executablePath).toBe(winExePath);
      expect(discovery32.isWindowsBinaryOnMac).toBe(true);

      // 2. Replace .app binary with 64-bit Mach-O header (0xfeedfacf LE) -> selects native macOS binary
      const machO64Buf = Buffer.alloc(64);
      machO64Buf.writeUInt32LE(0xfeedfacf, 0);
      fs.writeFileSync(macAppBin, machO64Buf, { mode: 0o755 });

      const header64 = launcherEngine.inspectMacMachOHeader(macAppBin);
      expect(header64).toEqual({
        isMachO: true,
        is64Bit: true,
        is32BitOnly: false,
      });

      launcherEngine.invalidateScanCaches();
      const discovery64 = launcherEngine.findPrimaryExecutable(mockInstallDir, {
        platform: 'darwin',
        hintName: 'Another World',
      });
      expect(discovery64.executablePath).toBe(macAppBin);
      expect(discovery64.isWindowsBinaryOnMac).toBe(false);
    });

    it('Test E: computeSmoothedDownloadSpeed stabilizes 0.5 MB/s decompression dips and 31 MB/s socket buffer bursts into a steady rolling speed', () => {
      const MB = 1024 * 1024;
      const taskId = 'speed-smooth-test-1';

      // Tick 1 (t=1000ms): 18.0 MB/s steady start
      const s1 = launcherEngine.computeSmoothedDownloadSpeed(taskId, {
        bytesDownloaded: 18 * MB,
        rawSpeedBytesPerSec: 18 * MB,
        decompressedSpeedBytesPerSec: 18 * MB,
        nowMs: 1000,
      });
      expect(s1).toBe(18 * MB);

      // Tick 2 (t=2000ms): 0.5 MB/s single-chunk decompression pause while decompressed write is 22 MB/s
      const s2 = launcherEngine.computeSmoothedDownloadSpeed(taskId, {
        bytesDownloaded: Math.round(18.5 * MB),
        rawSpeedBytesPerSec: Math.round(0.5 * MB),
        decompressedSpeedBytesPerSec: 22 * MB,
        nowMs: 2000,
      });
      // Must NOT plunge down to 0.5 MB/s — stays smoothly above 15 MB/s
      expect(s2 / MB).toBeGreaterThanOrEqual(15);
      expect(s2 / MB).toBeLessThanOrEqual(20);

      // Tick 3 (t=3000ms): 31.0 MB/s OS kernel TCP receive buffer flush burst
      const s3 = launcherEngine.computeSmoothedDownloadSpeed(taskId, {
        bytesDownloaded: Math.round(49.5 * MB),
        rawSpeedBytesPerSec: 31 * MB,
        decompressedSpeedBytesPerSec: 16 * MB,
        nowMs: 3000,
      });
      // Must NOT spike to 31 MB/s — stays smoothly in the 15-22 MB/s band
      expect(s3 / MB).toBeGreaterThanOrEqual(15);
      expect(s3 / MB).toBeLessThanOrEqual(22);

      // Also verify clearStaleGogdlManifestCache removes cached manifest file
      const fakeHome = path.join(tmpRoot, 'gogdl-cache-home');
      const cachedManifest = path.join(
        fakeHome,
        'Library/Application Support/heroic_gogdl/manifests/2006298293'
      );
      writeTempFile(cachedManifest, '{"version": 2}', 0o644);
      expect(fs.existsSync(cachedManifest)).toBe(true);
      launcherEngine.clearStaleGogdlManifestCache('gog-2006298293', { homedir: fakeHome });
      expect(fs.existsSync(cachedManifest)).toBe(false);
    });

    it('normalizes bare protocol-relative GOG avatar hashes to valid HTTPS CDN image URLs', async () => {
      const storeSync = require('../electron/storeSync.cjs');
      const { normalizeGogAvatarUrl: tsNormalize } = await import('../src/services/integrations/gogIntegration');

      const bareProtocolRelative =
        '//images.gog-statics.com/79dd38e771b528424a97b2282ec62cb245ace21f3aaadeae142518d6ad4066ef';
      const expectedNormalized =
        'https://images.gog-statics.com/79dd38e771b528424a97b2282ec62cb245ace21f3aaadeae142518d6ad4066ef_menu_user_av_big2.jpg';

      expect(storeSync.normalizeGogAvatarUrl(bareProtocolRelative)).toBe(expectedNormalized);
      expect(tsNormalize(bareProtocolRelative)).toBe(expectedNormalized);

      // Also test when avatars map is provided from menu.gog.com/v1/account/basic
      const avatarsMap = {
        menu_user_av_big2:
          'https://images.gog-statics.com/79dd38e771b528424a97b2282ec62cb245ace21f3aaadeae142518d6ad4066ef_menu_user_av_big2.jpg',
      };
      expect(storeSync.normalizeGogAvatarUrl(bareProtocolRelative, avatarsMap)).toBe(expectedNormalized);
      expect(tsNormalize(bareProtocolRelative, avatarsMap)).toBe(expectedNormalized);
    });
  });

  // =========================================================================
  // 23. MACOS STEAM WINDOWS BUILD VIA CROSSOVER (steam-win-compat) & BOTTLE RESOLUTION
  // =========================================================================
  describe('23. macOS Steam Windows Build via CrossOver (steam-win-compat), Bottle VDF Discovery & Direct CrossOver Launch', () => {
    it('Test 1: launcherEngine.getGameInstallInfo on darwin returns [steam-win-compat] for Windows-only Steam games and [steam-mac-native, steam-win-compat] when native macOS build exists', async () => {
      const tempHome = path.join(tmpRoot, 'steam-compat-home-1');
      const tempUserData = path.join(tmpRoot, 'steam-compat-userdata-1');
      fs.mkdirSync(tempHome, { recursive: true });
      fs.mkdirSync(tempUserData, { recursive: true });

      const winOnlyInfo = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'steam',
          platformGameId: '1091500',
          title: 'Cyberpunk 2077',
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir: tempUserData,
          skipNetwork: true,
          mockSteamAppDetails: {
            platforms: {
              windows: true,
              mac: false,
            },
          },
        }
      );

      expect(winOnlyInfo.availableInstallers).toHaveLength(1);
      expect(winOnlyInfo.availableInstallers.map((i: any) => i.id)).toEqual([
        'steam-win-compat',
      ]);
      expect(winOnlyInfo.availableInstallers[0].id).toBe('steam-win-compat');
      expect(winOnlyInfo.availableInstallers[0].os).toBe('windows');
      expect(winOnlyInfo.availableInstallers[0].name).toContain('Windows Build via CrossOver');

      const macSupportedInfo = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'steam',
          platformGameId: '1086940',
          title: "Baldur's Gate 3",
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir: tempUserData,
          skipNetwork: true,
          mockSteamAppDetails: {
            platforms: {
              windows: true,
              mac: true,
            },
          },
        }
      );

      expect(macSupportedInfo.availableInstallers.map((i: any) => i.id)).toEqual([
        'steam-mac-native',
        'steam-win-compat',
      ]);
    });

    it('Test 2: GameInstallModal on macOS for a Windows-only Steam game pre-selects steam-win-compat by default, renders CrossOver Windows Steam Bottle pipeline, and passes installerId="steam-win-compat"', async () => {
      const mockSteamWinGame: CanonicalGame = {
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        steamAppId: 1091500,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: false,
          },
        ],
        headerImage: 'https://cdn.example.com/cp2077.jpg',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: ['Cyberpunk'],
      };

      const infoSpy = vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '1091500',
        hostPlatform: 'darwin',
        estimatedSizeBytes: 70 * 1024 * 1024 * 1024,
        defaultInstallDir: '/Users/test/Library/Application Support/Steam/steamapps/common',
        availableInstallDirs: ['/Users/test/Library/Application Support/Steam/steamapps/common'],
        availableInstallers: [
          {
            id: 'steam-win-compat',
            name: 'Cyberpunk 2077 (Windows Build via CrossOver — Windows Steam Bottle)',
            os: 'windows',
            totalSizeBytes: 70 * 1024 * 1024 * 1024,
          },
        ],
        canDirectDownload: false,
        requiresStoreClientFallback: true,
        diskSpace: {
          targetPath: '/Users/test/Library/Application Support/Steam/steamapps/common',
          freeBytes: 250 * 1024 * 1024 * 1024,
          totalBytes: 500 * 1024 * 1024 * 1024,
          usedBytes: 250 * 1024 * 1024 * 1024,
        },
      } as any);

      const startInstallSpy = vi.spyOn(launcherService, 'startInstall').mockResolvedValue({
        success: true,
      } as any);

      const states: any[] = [];
      const effectsRan: boolean[] = [];

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

      const renderModal = () => {
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
            game: mockSteamWinGame,
            onClose: vi.fn(),
          });
          const html = renderToString(vnode);
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      try {
        renderModal();
        await new Promise((r) => setTimeout(r, 15));
        const loadedRender = renderModal();

        expect(loadedRender.html).toContain('AUTO-DETECTED • WINDOWS BUILD (CROSSOVER / WINE)');
        expect(loadedRender.html).toContain(
          'CrossOver Windows Steam Bottle + Live ACF Progress Monitor'
        );

        const installBtn = findElements(
          loadedRender.vnode,
          (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
        )[0];
        expect(installBtn).toBeDefined();
        await installBtn.props.onClick();

        expect(startInstallSpy).toHaveBeenCalledTimes(1);
        expect(startInstallSpy.mock.calls[0][0]).toMatchObject({
          gameId: 'steam-1091500',
          platformId: 'steam',
          installerId: 'steam-win-compat',
          os: 'windows',
        });
      } finally {
        infoSpy.mockRestore();
        startInstallSpy.mockRestore();
      }
    });

    it('Test 3: launcherEngine.installGame on darwin with installerId="steam-win-compat" launches Windows Steam inside the CrossOver bottle and saves CrossOver bottle launch config', async () => {
      const tempDir = path.join(tmpRoot, 'steam-compat-install-3');
      const tempHome = path.join(tempDir, 'home');
      const tempUserData = path.join(tempDir, 'userdata');
      fs.mkdirSync(tempHome, { recursive: true });
      fs.mkdirSync(tempUserData, { recursive: true });

      const mockCrossoverWine = path.join(
        tempHome,
        'Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'
      );
      const mockBottleSteamExe = path.join(
        tempHome,
        'Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steam.exe'
      );
      writeTempFile(mockCrossoverWine, '#!/bin/sh\nexit 0\n', 0o755);
      writeTempFile(mockBottleSteamExe, 'MZ-mock-crossover-steam-exe', 0o755);

      const openedUris: string[] = [];
      const res = await launcherEngine.installGame(
        {
          gameId: 'steam-1091500',
          title: 'Cyberpunk 2077',
          platformId: 'steam',
          platformGameId: '1091500',
          steamAppId: 1091500,
          installDir: tempDir,
          installerId: 'steam-win-compat',
          os: 'windows',
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir: tempUserData,
          disableSteamMonitor: true,
          onOpenExternal: (uri: string) => openedUris.push(uri),
        }
      );

      expect(res.success).toBe(true);
      // Should NOT open native macOS steam://install/1091500 when Wine Steam inside CrossOver bottle succeeds
      expect(openedUris).toHaveLength(0);
      expect(res.task.statusMessage).toContain('Installing via Windows Steam in CrossOver / Wine');

      const launchConfigs = launcherEngine.getGameLaunchConfigs({ userDataDir: tempUserData });
      expect(launchConfigs['steam-1091500']).toBeDefined();
      expect(launchConfigs['steam-1091500'].preferredPlatformId).toBe('steam');
      expect(launchConfigs['steam-1091500'].compatibilityLayer).toBe('crossover');
      expect(launchConfigs['steam-1091500'].wineBottleName).toBe('Steam');
    });

    it('Test 4: Launching a Windows .exe inside steamapps/common/ on macOS runs via CrossOver (compatibility_layer:crossover) with SteamAppId env set and NEVER falls back to native macOS steam://rungameid', async () => {
      const tempDir = path.join(tmpRoot, 'steam-win-exe-launch-mac');
      const tempHome = path.join(tempDir, 'home');
      const tempUserData = path.join(tempDir, 'userdata');
      fs.mkdirSync(tempHome, { recursive: true });
      fs.mkdirSync(tempUserData, { recursive: true });

      const envDumpFile = path.join(tempDir, 'spawned-env.json');
      const mockCrossoverWine = path.join(
        tempHome,
        'Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'
      );
      writeTempFile(
        mockCrossoverWine,
        `#!/bin/sh
printf '{"exe":"%s","SteamAppId":"%s","SteamGameId":"%s","CX_BOTTLE":"%s"}\\n' "$1" "$SteamAppId" "$SteamGameId" "$CX_BOTTLE" > "${envDumpFile}"
sleep 1
`,
        0o755
      );

      const bottleDir = path.join(
        tempHome,
        'Library/Application Support/CrossOver/Bottles/Steam'
      );
      fs.mkdirSync(bottleDir, { recursive: true });

      const gameInstallDir = path.join(
        tempHome,
        'Library/Application Support/Steam/steamapps/common/Quake II'
      );
      const quakeExe = path.join(gameInstallDir, 'rerelease/quake2.exe');
      writeTempFile(quakeExe, 'MZ-fake-windows-pe-64bit-binary', 0o755);

      const openedUris: string[] = [];
      const launchRes = await launcherEngine.launchGame(
        {
          gameId: 'steam-2320',
          title: 'Quake II',
          platformId: 'steam',
          platformGameId: '2320',
          steamAppId: 2320,
          installPath: gameInstallDir,
          executablePath: quakeExe,
          isWindowsBinaryOnMac: true,
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir: tempUserData,
          onOpenExternal: (uri: string) => openedUris.push(uri),
        }
      );

      expect(launchRes.success).toBe(true);
      expect(launchRes.session).toBeDefined();
      expect(launchRes.session.launchMethod).toBe('compatibility_layer:crossover');
      expect(openedUris).toHaveLength(0);
      expect(launcherEngine.openedExternalUris).not.toContain('steam://rungameid/2320');

      for (let i = 0; i < 20 && !fs.existsSync(envDumpFile); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(fs.existsSync(envDumpFile)).toBe(true);
      const dumped = JSON.parse(fs.readFileSync(envDumpFile, 'utf8'));
      expect(dumped.exe).toBe(quakeExe);
      expect(dumped.SteamAppId).toBe('2320');
      expect(dumped.SteamGameId).toBe('2320');
      expect(dumped.CX_BOTTLE).toBe('Steam');

      // Also verify steam_appid.txt was written beside the executable
      const steamAppIdTxt = path.join(path.dirname(quakeExe), 'steam_appid.txt');
      expect(fs.existsSync(steamAppIdTxt)).toBe(true);
      expect(fs.readFileSync(steamAppIdTxt, 'utf8').trim()).toBe('2320');

      await launcherEngine.stopGame({ gameId: 'steam-2320' });
    });

    it('Test 5: toLocalFsPath & discoverSteamLocations resolve Wine Z:\\ POSIX paths and CrossOver bottle C:\\ secondary libraries in libraryfolders.vdf', () => {
      const tempDir = path.join(tmpRoot, 'steam-bottle-vdf-test');
      const tempHome = path.join(tempDir, 'home');
      const tempUserData = path.join(tempDir, 'userdata');
      fs.mkdirSync(tempHome, { recursive: true });
      fs.mkdirSync(tempUserData, { recursive: true });

      // 1. Direct toLocalFsPath verification for Z:\ and C:\ paths
      const hostExternalLib = path.join(tempDir, 'ExternalMacSteamLib');
      fs.mkdirSync(path.join(hostExternalLib, 'steamapps'), { recursive: true });

      const zWinePath = 'Z:' + hostExternalLib.replace(/\//g, '\\\\');
      expect(launcherEngine.toLocalFsPath(zWinePath)).toBe(hostExternalLib);

      const bottleDriveC = path.join(
        tempHome,
        'Library/Application Support/CrossOver/Bottles/Steam/drive_c'
      );
      const bottleSecondaryLib = path.join(bottleDriveC, 'SecondarySteamLibrary');
      fs.mkdirSync(path.join(bottleSecondaryLib, 'steamapps'), { recursive: true });

      expect(
        launcherEngine.toLocalFsPath('C:\\\\SecondarySteamLibrary', [bottleDriveC])
      ).toBe(bottleSecondaryLib);

      // 2. discoverSteamLocations & scanAllInstalledGames with CrossOver bottle libraryfolders.vdf
      const bottleSteamRoot = path.join(bottleDriveC, 'Program Files (x86)/Steam');
      const bottleSteamApps = path.join(bottleSteamRoot, 'steamapps');
      writeTempFile(
        path.join(bottleSteamApps, 'libraryfolders.vdf'),
        `"libraryfolders"
{
  "0"
  {
    "path" "C:\\\\Program Files (x86)\\\\Steam"
  }
  "1"
  {
    "path" "C:\\\\SecondarySteamLibrary"
  }
  "2"
  {
    "path" "${zWinePath}"
  }
}`
      );

      // Game inside bottle C:\SecondarySteamLibrary
      writeTempFile(
        path.join(bottleSecondaryLib, 'steamapps/appmanifest_2320.acf'),
        `"AppState"
{
  "appid" "2320"
  "name" "Quake II"
  "installdir" "Quake II"
  "SizeOnDisk" "1500000000"
  "StateFlags" "4"
}`
      );
      const quakeBottleExe = path.join(
        bottleSecondaryLib,
        'steamapps/common/Quake II/quake2.exe'
      );
      writeTempFile(quakeBottleExe, 'MZ-quake2-bottle-exe');

      // Game inside Z:\ mapped host library
      writeTempFile(
        path.join(hostExternalLib, 'steamapps/appmanifest_1091500.acf'),
        `"AppState"
{
  "appid" "1091500"
  "name" "Cyberpunk 2077"
  "installdir" "Cyberpunk 2077"
  "SizeOnDisk" "70000000000"
  "StateFlags" "4"
}`
      );
      const cpHostExe = path.join(
        hostExternalLib,
        'steamapps/common/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe'
      );
      writeTempFile(cpHostExe, 'MZ-cp2077-exe');

      const locations = launcherEngine.discoverSteamLocations({
        platform: 'darwin',
        homedir: tempHome,
      });
      expect(locations.steamappsDirs).toEqual(
        expect.arrayContaining([
          bottleSteamApps,
          path.join(bottleSecondaryLib, 'steamapps'),
          path.join(hostExternalLib, 'steamapps'),
        ])
      );

      launcherEngine.invalidateScanCaches();
      const scanRes = launcherEngine.scanAllInstalledGames({
        platform: 'darwin',
        homedir: tempHome,
        userDataDir: tempUserData,
      });
      expect(scanRes.success).toBe(true);
      const quakeRec = scanRes.installedGames.find(
        (g: any) => g.platformId === 'steam' && g.platformGameId === '2320'
      );
      expect(quakeRec).toBeDefined();
      expect(quakeRec.executablePath).toBe(quakeBottleExe);
      expect(quakeRec.isWindowsBinaryOnMac).toBe(true);

      const cpRec = scanRes.installedGames.find(
        (g: any) => g.platformId === 'steam' && g.platformGameId === '1091500'
      );
      expect(cpRec).toBeDefined();
      expect(cpRec.executablePath).toBe(cpHostExe);
      expect(cpRec.isWindowsBinaryOnMac).toBe(true);
    });
  });

  // =========================================================================
  // 24. EPIC GAMES ESTIMATED SIZE RESOLUTION FIX (BINARY MANIFEST & SLUG RESOLUTION)
  // =========================================================================
  describe('24. Epic Games Estimated Size Resolution Fix (parseEpicManifestBuffer & Slug-to-AppName Resolution)', () => {
    const createSyntheticEpicBinaryManifest = (
      chunkPartSizes: number[],
      chunkDownloadSizes: bigint[]
    ): Buffer => {
      const zlib = require('node:zlib');

      // 1. ManifestMeta (16 bytes)
      const metaSize = 16;
      const metaBuf = Buffer.alloc(metaSize);
      metaBuf.writeUInt32LE(metaSize, 0);

      // 2. ChunkDataList
      const cdlCount = chunkDownloadSizes.length;
      const cdlSize = 9 + cdlCount * (16 + 8 + 20 + 1 + 4 + 8);
      const cdlBuf = Buffer.alloc(cdlSize);
      cdlBuf.writeUInt32LE(cdlSize, 0);
      cdlBuf.writeUInt8(0, 4);
      cdlBuf.writeUInt32LE(cdlCount, 5);
      const windowSizeOffset = 9 + cdlCount * (16 + 8 + 20 + 1);
      for (let i = 0; i < cdlCount; i++) {
        cdlBuf.writeUInt32LE(1048576, windowSizeOffset + i * 4);
      }
      const fileSizeOffset = windowSizeOffset + cdlCount * 4;
      for (let i = 0; i < cdlCount; i++) {
        cdlBuf.writeBigUInt64LE(chunkDownloadSizes[i], fileSizeOffset + i * 8);
      }

      // 3. FileManifestList
      const fmlCount = chunkPartSizes.length;
      // Layout: 9B header + filename (4B*N) + symlink (4B*N) + sha_hash+flags (21B*N) + install_tags (4B*N) + chunk_parts ((4B + 28B)*N)
      const fmlSize = 9 + fmlCount * (4 + 4 + 21 + 4 + 4 + 28);
      const fmlBuf = Buffer.alloc(fmlSize);
      fmlBuf.writeUInt32LE(fmlSize, 0);
      fmlBuf.writeUInt8(0, 4);
      fmlBuf.writeUInt32LE(fmlCount, 5);

      let pos = 9 + fmlCount * (4 + 4 + 21 + 4);
      for (let i = 0; i < fmlCount; i++) {
        // partCount = 1
        fmlBuf.writeUInt32LE(1, pos);
        pos += 4;
        // struct_size = 28, guid = 16B zeros, offset = 0, size = chunkPartSizes[i]
        fmlBuf.writeUInt32LE(28, pos);
        fmlBuf.writeUInt32LE(chunkPartSizes[i], pos + 24);
        pos += 28;
      }

      const uncompressedBody = Buffer.concat([metaBuf, cdlBuf, fmlBuf]);
      const compressedBody = zlib.deflateSync(uncompressedBody);

      const headerSize = 41;
      const headerBuf = Buffer.alloc(headerSize);
      headerBuf.writeUInt32LE(0x44bec00c, 0); // Epic binary manifest magic
      headerBuf.writeUInt32LE(headerSize, 4);
      headerBuf.writeUInt32LE(uncompressedBody.length, 8);
      headerBuf.writeUInt32LE(compressedBody.length, 12);
      headerBuf.writeUInt8(1, 36); // storedAs = 1 (zlib compressed)

      return Buffer.concat([headerBuf, compressedBody]);
    };

    it('parses binary Epic .manifest buffers (0x44bec00c magic + zlib body) and resolves exact estimatedSizeBytes for Epic games via slug-to-appName lookup', async () => {
      // Part 1: Direct unit test of launcherEngine.parseEpicManifestBuffer
      // Two file chunk parts totaling 2,268,366,790 bytes (1,200,000,000 + 1,068,366,790)
      const syntheticManifestBuf = createSyntheticEpicBinaryManifest(
        [1200000000, 1068366790],
        [1100000000n, 911455232n]
      );

      const parsedManifest = launcherEngine.parseEpicManifestBuffer(syntheticManifestBuf);
      expect(parsedManifest).not.toBeNull();
      expect(parsedManifest.diskSize).toBe(2268366790);
      expect(parsedManifest.downloadSize).toBe(2011455232);

      // Part 2: Integration test of launcherEngine.getGameInstallInfo with slug platformGameId='sable' and title='Sable'
      const tempHome = path.join(tmpRoot, 'epic-manifest-home');
      const tempUserData = path.join(tmpRoot, 'epic-manifest-userdata');
      const legConfigDir = path.join(tempUserData, 'legendaryConfig', 'legendary');
      const manifestsDir = path.join(legConfigDir, 'manifests');
      fs.mkdirSync(manifestsDir, { recursive: true });
      fs.mkdirSync(tempHome, { recursive: true });

      const sableAppName = '9b48cbb1a0cf4a73b87ccbf4cde04b26';
      fs.writeFileSync(
        path.join(legConfigDir, 'assets.json'),
        JSON.stringify(
          {
            Windows: [
              {
                app_name: sableAppName,
                app_title: 'Sable',
                asset_id: sableAppName,
                build_version: '4.1.2',
                catalog_item_id: 'f1927e4b2a9d41eab2df0c31ff724279',
                namespace: '078c934e476645a982e12f1d7ce00c88',
              },
            ],
            Mac: [],
          },
          null,
          2
        ),
        'utf8'
      );

      // Write cached binary .manifest file in legendaryConfig/legendary/manifests/
      fs.writeFileSync(
        path.join(manifestsDir, `${sableAppName}_Windows.manifest`),
        syntheticManifestBuf
      );

      const resolvedInfo = launcherEngine.resolveEpicAppAndPlatforms(
        {
          platformId: 'epic',
          platformGameId: 'sable',
          title: 'Sable',
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir: tempUserData,
        }
      );
      expect(resolvedInfo.resolvedAppName).toBe(sableAppName);
      expect(resolvedInfo.namespace).toBe('078c934e476645a982e12f1d7ce00c88');
      expect(resolvedInfo.catalogItemId).toBe('f1927e4b2a9d41eab2df0c31ff724279');

      const installInfo = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'epic',
          platformGameId: 'sable',
          title: 'Sable',
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir: tempUserData,
          skipNetwork: true,
        }
      );

      expect(installInfo.estimatedSizeBytes).toBe(2268366790);
      expect(installInfo.availableInstallers.length).toBeGreaterThan(0);
      expect(installInfo.availableInstallers[0].totalSizeBytes).toBe(2268366790);
    });
  });

  // =========================================================================
  // 25. CROSSOVER 26 PER-GAME SETTINGS, DYNAMIC LAUNCH PREVIEW & CONFIG MODAL
  // =========================================================================
  describe('25. CrossOver 26 Per-Game Settings (cxbottle.conf & user.reg), Dynamic Launch Mode Preview & GameLaunchConfigModal', () => {
    it('Issue 2: applyCrossOverPerGameSettings writes CX_GRAPHICS_BACKEND (d3dmetal, dxmt, dxvk, wined3d, auto removal), D3DM_ENABLE_METALFX, DXMT_ENABLE_NVEXT, mutually exclusive WINEMSYNC/WINEESYNC to cxbottle.conf, and RetinaMode + LogPixels DPI to user.reg', () => {
      const bottleDir = path.join(tmpRoot, 'crossover-26-bottle');
      fs.mkdirSync(bottleDir, { recursive: true });
      const cxbottleConfPath = path.join(bottleDir, 'cxbottle.conf');
      const userRegPath = path.join(bottleDir, 'user.reg');

      writeTempFile(
        cxbottleConfPath,
        `[Bottle]\n"BottleName" = "Steam"\n\n[EnvironmentVariables]\n"CUSTOM_VAR" = "keep_me"\n`
      );
      writeTempFile(
        userRegPath,
        `WINE REGISTRY Version 2\n\n[Software\\\\Wine\\\\Drivers]\n"Audio"="coreaudio"\n`
      );

      const mockLayer = {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
      };

      // 1. d3dmetal + DLSS enabled + High Resolution Mode enabled (192 DPI) + MSync enabled + HUDs
      const env1: Record<string, string> = {};
      launcherEngine.applyCrossOverPerGameSettings(
        mockLayer,
        {
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverDlss: true,
          crossoverHighResolutionMode: true,
          wineMsync: true,
          wineEsync: false,
          metalHud: true,
          dxvkHud: true,
        },
        env1,
        bottleDir,
        { skipRegistrySpawn: true }
      );

      expect(env1.CX_GRAPHICS_BACKEND).toBe('d3dmetal');
      expect(env1.WINED3DMETAL).toBe('1');
      expect(env1.D3DM_ENABLE_METALFX).toBe('1');
      expect(env1.DXMT_ENABLE_NVEXT).toBe('1');
      expect(env1.WINEMSYNC).toBe('1');
      expect(env1.WINEESYNC).toBe('0');
      expect(env1.MTL_HUD_ENABLED).toBe('1');
      expect(env1.DXVK_HUD).toBe('devinfo,fps,frametimes');

      const conf1 = fs.readFileSync(cxbottleConfPath, 'utf8');
      expect(conf1).toContain('"CUSTOM_VAR" = "keep_me"');
      expect(conf1).toContain('"CX_GRAPHICS_BACKEND" = "d3dmetal"');
      expect(conf1).toContain('"D3DM_ENABLE_METALFX" = "1"');
      expect(conf1).toContain('"DXMT_ENABLE_NVEXT" = "1"');
      expect(conf1).toContain('"WINEMSYNC" = "1"');
      expect(conf1).toContain('"WINEESYNC" = "0"');

      const reg1 = fs.readFileSync(userRegPath, 'utf8');
      expect(reg1).toContain('[Software\\\\Wine\\\\Mac Driver]');
      expect(reg1).toContain('"RetinaMode"="y"');
      expect(reg1).toContain('[Control Panel\\\\Desktop]');
      expect(reg1).toContain('"LogPixels"=dword:000000c0');

      // 2. dxmt + High Resolution Mode disabled (96 DPI) + ESync enabled (MSync disabled)
      const env2: Record<string, string> = {};
      launcherEngine.applyCrossOverPerGameSettings(
        mockLayer,
        {
          crossoverGraphicsBackend: 'dxmt',
          crossoverDlss: true,
          crossoverHighResolutionMode: false,
          wineMsync: false,
          wineEsync: true,
        },
        env2,
        bottleDir,
        { skipRegistrySpawn: true }
      );
      expect(env2.CX_GRAPHICS_BACKEND).toBe('dxmt');
      expect(env2.WINED3DMETAL).toBeUndefined();
      expect(env2.D3DM_ENABLE_METALFX).toBe('1');
      expect(env2.DXMT_ENABLE_NVEXT).toBe('1');
      expect(env2.WINEMSYNC).toBe('0');
      expect(env2.WINEESYNC).toBe('1');

      const conf2 = fs.readFileSync(cxbottleConfPath, 'utf8');
      expect(conf2).toContain('"CX_GRAPHICS_BACKEND" = "dxmt"');
      expect(conf2).toContain('"WINEMSYNC" = "0"');
      expect(conf2).toContain('"WINEESYNC" = "1"');

      const reg2 = fs.readFileSync(userRegPath, 'utf8');
      expect(reg2).toContain('"RetinaMode"="n"');
      expect(reg2).not.toContain('"RetinaMode"="y"');
      expect(reg2).toContain('[Control Panel\\\\Desktop]');
      expect(reg2).toContain('"LogPixels"=dword:00000060');
      expect(reg2).not.toContain('"LogPixels"=dword:000000c0');

      // 2b. Verify mutual exclusion when legacy config has both wineMsync: true and wineEsync: true, or both false
      const envBothTrue: Record<string, string> = {};
      launcherEngine.applyCrossOverPerGameSettings(
        mockLayer,
        { wineMsync: true, wineEsync: true },
        envBothTrue,
        bottleDir,
        { skipRegistrySpawn: true }
      );
      expect(envBothTrue.WINEMSYNC).toBe('1');
      expect(envBothTrue.WINEESYNC).toBe('0');

      const envBothFalse: Record<string, string> = {};
      launcherEngine.applyCrossOverPerGameSettings(
        mockLayer,
        { wineMsync: false, wineEsync: false },
        envBothFalse,
        bottleDir,
        { skipRegistrySpawn: true }
      );
      expect(envBothFalse.WINEMSYNC).toBe('0');
      expect(envBothFalse.WINEESYNC).toBe('0');

      // 3. dxvk (forces DLSS off even if crossoverDlss: true) and wined3d
      const env3: Record<string, string> = {};
      launcherEngine.applyCrossOverPerGameSettings(
        mockLayer,
        {
          crossoverGraphicsBackend: 'dxvk',
          crossoverDlss: true,
        },
        env3,
        bottleDir,
        { skipRegistrySpawn: true }
      );
      expect(env3.CX_GRAPHICS_BACKEND).toBe('dxvk');
      expect(env3.D3DM_ENABLE_METALFX).toBe('0');
      expect(env3.DXMT_ENABLE_NVEXT).toBe('0');
      expect(fs.readFileSync(cxbottleConfPath, 'utf8')).toContain(
        '"CX_GRAPHICS_BACKEND" = "dxvk"'
      );

      const env4: Record<string, string> = {};
      launcherEngine.applyCrossOverPerGameSettings(
        mockLayer,
        {
          crossoverGraphicsBackend: 'wined3d',
          crossoverDlss: false,
        },
        env4,
        bottleDir,
        { skipRegistrySpawn: true }
      );
      expect(env4.CX_GRAPHICS_BACKEND).toBe('wined3d');
      expect(fs.readFileSync(cxbottleConfPath, 'utf8')).toContain(
        '"CX_GRAPHICS_BACKEND" = "wined3d"'
      );

      // 4. 'auto' removes CX_GRAPHICS_BACKEND from both env and cxbottle.conf
      const env5: Record<string, string> = {
        CX_GRAPHICS_BACKEND: 'wined3d',
        WINED3DMETAL: '1',
      };
      launcherEngine.applyCrossOverPerGameSettings(
        mockLayer,
        {
          crossoverGraphicsBackend: 'auto',
          crossoverDlss: false,
        },
        env5,
        bottleDir,
        { skipRegistrySpawn: true }
      );
      expect(env5.CX_GRAPHICS_BACKEND).toBeUndefined();
      expect(env5.WINED3DMETAL).toBeUndefined();
      const conf5 = fs.readFileSync(cxbottleConfPath, 'utf8');
      expect(conf5).not.toContain('CX_GRAPHICS_BACKEND');
      expect(conf5).toContain('"CUSTOM_VAR" = "keep_me"');
    });

    it('Issue 3A: launcherService.resolveEffectiveLaunchModePreview returns accurate build classifications, dynamic badges, descriptions, and warnings across mac_native_app, windows_exe_on_mac, windows_native, and not_installed', async () => {
      const svc = new LauncherService();

      // 1. mac_native_app on darwin
      const macGame: CanonicalGame = {
        id: 'gog-1456460669',
        title: "Baldur's Gate 3",
        sortTitle: "Baldur's Gate 3",
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1456460669',
            installed: true,
            installPath: "/Applications/Baldur's Gate 3.app",
            executablePath: "/Applications/Baldur's Gate 3.app/Contents/MacOS/BaldursGate3",
            isWindowsBinaryOnMac: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const macPreview = svc.resolveEffectiveLaunchModePreview(macGame, 'gog');
      expect(macPreview.detectedBuildType).toBe('mac_native_app');
      expect(macPreview.detectedBuildLabel).toContain('macOS Native App Bundle (.app)');
      expect(macPreview.autoResolvedMethod).toBe('direct');
      expect(macPreview.modeNotes.auto.badge).toBe('Recommended');
      expect(macPreview.modeNotes.direct.badge).toBe('Native macOS');
      expect(macPreview.modeNotes.compatibility_layer.badge).toBe('Not Needed');
      expect(macPreview.modeNotes.compatibility_layer.warning).toContain(
        'already a native macOS build'
      );

      // 2. windows_exe_on_mac on darwin
      const winExeOnMacGame: CanonicalGame = {
        id: 'steam-2320',
        title: 'Quake II',
        sortTitle: 'Quake II',
        steamAppId: 2320,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '2320',
            installed: true,
            installPath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Quake II',
            executablePath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Quake II/quake2.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const winOnMacPreview = svc.resolveEffectiveLaunchModePreview(
        winExeOnMacGame,
        'steam',
        { compatibilityLayer: 'crossover', wineBottleName: 'Steam' }
      );
      expect(winOnMacPreview.detectedBuildType).toBe('windows_exe_on_mac');
      expect(winOnMacPreview.detectedBuildLabel).toContain('Windows Build (.exe) on macOS');
      expect(winOnMacPreview.autoResolvedMethod).toBe('compatibility_layer');
      expect(winOnMacPreview.autoResolvedSummary).toContain('Bottle: "Steam"');
      expect(winOnMacPreview.availableModes).toEqual(['auto', 'compatibility_layer']);
      expect(winOnMacPreview.modeNotes.auto.badge).toBe('Recommended');
      expect(winOnMacPreview.modeNotes.compatibility_layer.badge).toBe('Custom Runner & Bottle');
      expect(winOnMacPreview.modeNotes.direct.badge).toBe('Requires Translation');
      expect(winOnMacPreview.modeNotes.direct.warning).toContain(
        'macOS cannot execute Windows .exe binaries natively'
      );
      expect(winOnMacPreview.modeNotes.storefront_uri.badge).toBe('Caution on macOS');
      expect(winOnMacPreview.modeNotes.storefront_uri.warning).toContain(
        'cannot launch Windows-only .exe builds directly'
      );

      // 2b. Bottle-path install before executablePath is hydrated classifies as windows_exe_on_mac (keeping High Resolution Mode visible)
      const unhydratedBottleInstallGame: CanonicalGame = {
        id: 'gog-bioshock',
        title: 'BioShock Remastered',
        sortTitle: 'BioShock Remastered',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: 'bioshock_remastered',
            installed: true,
            installPath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/GOG Games/BioShock Remastered',
            executablePath: undefined,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };
      const bottleInstallPreview = svc.resolveEffectiveLaunchModePreview(
        unhydratedBottleInstallGame,
        'gog'
      );
      expect(bottleInstallPreview.detectedBuildType).toBe('windows_exe_on_mac');
      expect(bottleInstallPreview.autoResolvedMethod).toBe('compatibility_layer');
      expect(bottleInstallPreview.visibleSections.compatibilityLayer).toBe(true);

      // 3. windows_native on win32
      (globalThis as any).window.electronAPI = { platform: 'win32' };
      try {
        const winNativePreview = svc.resolveEffectiveLaunchModePreview(winExeOnMacGame, 'steam');
        expect(winNativePreview.detectedBuildType).toBe('windows_native');
        expect(winNativePreview.detectedBuildLabel).toContain('Windows Native Build (.exe)');
        expect(winNativePreview.autoResolvedMethod).toBe('direct');
        expect(winNativePreview.modeNotes.direct.badge).toBe('Native Windows');
        expect(winNativePreview.modeNotes.compatibility_layer.warning).toContain(
          'not required on native Windows hosts'
        );
      } finally {
        delete (globalThis as any).window.electronAPI;
      }

      // 4. not_installed
      const uninstalledGame: CanonicalGame = {
        id: 'epic-alanwake2',
        title: 'Alan Wake 2',
        sortTitle: 'Alan Wake 2',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'AlanWake2',
            installed: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };
      const uninstalledPreview = svc.resolveEffectiveLaunchModePreview(uninstalledGame, 'epic');
      expect(uninstalledPreview.detectedBuildType).toBe('not_installed');
      expect(uninstalledPreview.isInstalled).toBe(false);
      expect(uninstalledPreview.autoResolvedMethod).toBe('storefront_uri');
      expect(uninstalledPreview.modeNotes.direct.badge).toBe('Requires Executable');
      expect(uninstalledPreview.modeNotes.direct.warning).toContain(
        'No local installation detected yet'
      );

      // 5. Verify saveLaunchConfig strips undefined keys and resetLaunchConfig deletes the config cleanly
      const savedPayloads: any[] = [];
      (globalThis as any).window.electronAPI = {
        saveGameLaunchConfig: async (cfg: any) => {
          savedPayloads.push(cfg);
          return launcherEngine.saveGameLaunchConfig(cfg, { userDataDir });
        },
      };

      await svc.saveLaunchConfig({
        gameId: 'steam-2320',
        launchMethod: 'compatibility_layer',
        customExecutablePath: '/tmp/custom/quake2.exe',
        crossoverGraphicsBackend: 'd3dmetal',
        crossoverHighResolutionMode: true,
        crossoverDlss: true,
      });
      expect(svc.getLaunchConfig('steam-2320')).toMatchObject({
        gameId: 'steam-2320',
        launchMethod: 'compatibility_layer',
        customExecutablePath: '/tmp/custom/quake2.exe',
        crossoverGraphicsBackend: 'd3dmetal',
        crossoverHighResolutionMode: true,
        crossoverDlss: true,
      });

      // Clear customExecutablePath and crossoverHighResolutionMode by passing undefined
      await svc.saveLaunchConfig({
        gameId: 'steam-2320',
        launchMethod: 'auto',
        customExecutablePath: undefined,
        crossoverGraphicsBackend: 'auto',
        crossoverHighResolutionMode: undefined,
      });
      expect(svc.getLaunchConfig('steam-2320')?.customExecutablePath).toBeUndefined();
      expect(svc.getLaunchConfig('steam-2320')?.crossoverHighResolutionMode).toBeUndefined();

      // Reset config completely
      await svc.resetLaunchConfig('steam-2320');
      expect(svc.getLaunchConfig('steam-2320')).toBeUndefined();
      expect(savedPayloads[savedPayloads.length - 1]).toMatchObject({
        gameId: 'steam-2320',
        reset: true,
      });
      const diskConfigs = launcherEngine.getGameLaunchConfigs({ userDataDir });
      expect(diskConfigs['steam-2320']).toBeUndefined();
    });

    it('Issue 3B: GameLaunchConfigModal renders CrossOver 26 controls, dynamic Launch Mode badges & warnings, enforces MSync/ESync mutual exclusion, disables DLSS on DXVK/WineD3D, and resets cleanly via resetLaunchConfig', async () => {
      const mockGame: CanonicalGame = {
        id: 'steam-2320',
        title: 'Quake II',
        sortTitle: 'Quake II',
        steamAppId: 2320,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '2320',
            installed: true,
            installPath:
              '/Users/test/Library/Application Support/Steam/steamapps/common/Quake II',
            executablePath:
              '/Users/test/Library/Application Support/Steam/steamapps/common/Quake II/quake2.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
        headerImage: '',
        developers: ['id Software'],
        publishers: ['Bethesda'],
        genres: ['Action'],
        tags: ['FPS'],
      };

      const detectSpy = vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          availableBottles: ['Steam', 'Default'],
        },
      ]);
      const getLayersSpy = vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          availableBottles: ['Steam', 'Default'],
        },
      ]);
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue();
      const resetSpy = vi.spyOn(launcherService, 'resetLaunchConfig').mockResolvedValue();

      const states: any[] = [];
      const effectsRan: boolean[] = [];

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

      const renderConfigModal = () => {
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
          const vnode = (GameLaunchConfigModal as any)({
            isOpen: true,
            game: mockGame,
            onClose: vi.fn(),
          });
          const html = renderToString(vnode);
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      try {
        renderConfigModal();
        await new Promise((r) => setTimeout(r, 15));
        const r1 = renderConfigModal();

        // Verify Detected Installation banner and dynamic Launch Mode badges (only Auto & Custom Runner & Bottle shown for windows_exe_on_mac)
        expect(r1.html).toContain('Detected Installation');
        expect(r1.html).toContain('Windows Build (.exe) on macOS');
        expect(r1.html).toContain('Custom Runner &amp; Bottle');
        expect(r1.html).not.toContain('Storefront Client Protocol');
        expect(r1.html).toContain('CrossOver 26 Rendering &amp; Display Settings');
        expect(r1.html).toContain('aria-label="Graphics Backend"');
        expect(r1.html).toContain('aria-label="High Resolution Mode"');
        expect(r1.html).toContain('DLSS (MetalFX Upscaling)');
        expect(r1.html).toContain(
          'Exposes NVIDIA DLSS to the game (powered by Apple MetalFX) for D3DMetal &amp; DXMT — select Quality / Balanced / Performance inside the game’s graphics settings.'
        );

        // Verify default MSync/ESync mutual exclusion state (MSync: ON, ESync: OFF)
        const getMsyncBtn = (vnode: any) =>
          findElements(
            vnode,
            (el) => el.type === 'button' && getTextContent(el).startsWith('MSync')
          )[0];
        const getEsyncBtn = (vnode: any) =>
          findElements(
            vnode,
            (el) => el.type === 'button' && getTextContent(el).startsWith('ESync')
          )[0];

        expect(getTextContent(getMsyncBtn(r1.vnode))).toBe('MSyncON');
        expect(getTextContent(getEsyncBtn(r1.vnode))).toBe('ESyncOFF');

        // Click ESync button -> turns ESync ON and automatically turns MSync OFF
        getEsyncBtn(r1.vnode).props.onClick();

        const rEsync = renderConfigModal();
        expect(getTextContent(getEsyncBtn(rEsync.vnode))).toBe('ESyncON');
        expect(getTextContent(getMsyncBtn(rEsync.vnode))).toBe('MSyncOFF');

        // Click MSync button -> turns MSync ON and automatically turns ESync OFF
        getMsyncBtn(rEsync.vnode).props.onClick();

        const rMsync = renderConfigModal();
        expect(getTextContent(getMsyncBtn(rMsync.vnode))).toBe('MSyncON');
        expect(getTextContent(getEsyncBtn(rMsync.vnode))).toBe('ESyncOFF');

        // Switch Launch Mode to 'compatibility_layer' -> verify Custom Compatibility Runner & Bottle mode selects cleanly
        const compatModeBtn = findElements(
          rMsync.vnode,
          (el) =>
            el.type === 'button' &&
            getTextContent(el).includes('Custom Compatibility Runner & Bottle')
        )[0];
        expect(compatModeBtn).toBeDefined();
        compatModeBtn.props.onClick();

        const r2 = renderConfigModal();
        expect(r2.html).toContain('Custom Compatibility Runner &amp; Bottle');

        // Select Graphics Backend = 'dxvk' -> verify DLSS button becomes disabled ('Unavailable')
        const backendSelect = findElements(
          r2.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'Graphics Backend'
        )[0];
        expect(backendSelect).toBeDefined();
        backendSelect.props.onChange({ target: { value: 'dxvk' } });

        const r3 = renderConfigModal();
        expect(r3.html).toContain('Not available with DXVK or WineD3D');
        expect(r3.html).toContain('Unavailable');

        // Select Graphics Backend = 'd3dmetal', enable High Resolution Mode and DLSS, and Save
        const backendSelect3 = findElements(
          r3.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'Graphics Backend'
        )[0];
        backendSelect3.props.onChange({ target: { value: 'd3dmetal' } });

        const retinaSelect = findElements(
          r3.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'High Resolution Mode'
        )[0];
        retinaSelect.props.onChange({ target: { value: 'true' } });

        const r4 = renderConfigModal();
        const dlssBtn = findElements(
          r4.vnode,
          (el) =>
            el.type === 'button' &&
            (getTextContent(el) === 'Disabled' || getTextContent(el) === 'Enabled')
        )[0];
        expect(dlssBtn).toBeDefined();
        dlssBtn.props.onClick();

        const r5 = renderConfigModal();
        const saveBtn = findElements(
          r5.vnode,
          (el) => el.type === 'button' && getTextContent(el).includes('Save Configuration')
        )[0];
        await saveBtn.props.onClick();

        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(saveSpy.mock.calls[0][0]).toMatchObject({
          gameId: 'steam-2320',
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverHighResolutionMode: true,
          crossoverDlss: true,
          wineMsync: true,
          wineEsync: false,
        });

        // Click "Reset to Auto-Detect" button -> verify resetLaunchConfig is called and state resets
        const resetBtn = findElements(
          r5.vnode,
          (el) => el.type === 'button' && getTextContent(el).includes('Reset to Auto-Detect')
        )[0];
        expect(resetBtn).toBeDefined();
        await resetBtn.props.onClick();

        expect(resetSpy).toHaveBeenCalledWith('steam-2320', 'steam');
        const rReset = renderConfigModal();
        const resetBackendSelect = findElements(
          rReset.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'Graphics Backend'
        )[0];
        expect(resetBackendSelect.props.value).toBe('auto');
      } finally {
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
        saveSpy.mockRestore();
        resetSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // 26. PER-GAME, PER-STOREFRONT LAUNCH & COMPATIBILITY SETTINGS (MULTI-STOREFRONT ISOLATION)
  // =========================================================================
  describe('26. Per-Game, Per-Storefront Launch & Compatibility Settings (Multi-Storefront Isolation)', () => {
    it('isolates GOG and Steam launch profiles, customExecutablePath, installation status, GameLaunchConfigModal storefront switching, and per-storefront reset without cross-storefront leakage', async () => {
      const tempGogExe = path.join(tmpRoot, 'GOG', 'Quake', 'quake_x64.exe');
      writeTempFile(tempGogExe, 'MZ-quake-gog-win64-binary');

      const multiStoreGame: CanonicalGame = {
        id: 'steam-2310',
        title: 'Quake',
        sortTitle: 'Quake',
        steamAppId: 2310,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1435827232',
            installed: false,
            playtimeMinutes: 45,
          },
          {
            platformId: 'steam',
            platformGameId: '2310',
            installed: false,
            playtimeMinutes: 120,
          },
        ],
        headerImage: '',
        developers: ['id Software'],
        publishers: ['Bethesda Softworks'],
        genres: ['Action'],
        tags: ['FPS'],
      };

      (globalThis as any).window.electronAPI = {
        saveGameLaunchConfig: async (cfg: any) =>
          launcherEngine.saveGameLaunchConfig(cfg, { userDataDir }),
        getGameLaunchConfigs: async () =>
          launcherEngine.getGameLaunchConfigs({ userDataDir }),
      };

      const detectSpy = vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          availableBottles: ['GOGBottle', 'SteamBottle', 'Default'],
        },
      ]);
      const getLayersSpy = vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          availableBottles: ['GOGBottle', 'SteamBottle', 'Default'],
        },
      ]);

      try {
        // 1. Configure GOG ('gog') with compatibility_layer, GOGBottle, d3dmetal, High Resolution Mode true, and customExecutablePath
        await launcherService.saveLaunchConfig(
          {
            gameId: multiStoreGame.id,
            preferredPlatformId: 'gog',
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            wineBottleName: 'GOGBottle',
            crossoverGraphicsBackend: 'd3dmetal',
            crossoverHighResolutionMode: true,
            customExecutablePath: tempGogExe,
          },
          'gog'
        );

        // 2. Configure Steam ('steam') with storefront_uri, SteamBottle, dxmt, High Resolution Mode false, and NO customExecutablePath
        await launcherService.saveLaunchConfig(
          {
            gameId: multiStoreGame.id,
            preferredPlatformId: 'steam',
            launchMethod: 'storefront_uri',
            compatibilityLayer: 'crossover',
            wineBottleName: 'SteamBottle',
            crossoverGraphicsBackend: 'dxmt',
            crossoverHighResolutionMode: false,
            customExecutablePath: undefined,
          },
          'steam'
        );

        // 3. Verify launcherService.getLaunchConfig(game.id, 'gog') and ('steam') return isolated profiles with zero cross-storefront leakage
        const gogCfg = launcherService.getLaunchConfig(multiStoreGame.id, 'gog');
        const steamCfg = launcherService.getLaunchConfig(multiStoreGame.id, 'steam');

        expect(gogCfg).toBeDefined();
        expect(gogCfg?.preferredPlatformId).toBe('gog');
        expect(gogCfg?.launchMethod).toBe('compatibility_layer');
        expect(gogCfg?.wineBottleName).toBe('GOGBottle');
        expect(gogCfg?.crossoverGraphicsBackend).toBe('d3dmetal');
        expect(gogCfg?.crossoverHighResolutionMode).toBe(true);
        expect(gogCfg?.customExecutablePath).toBe(tempGogExe);

        expect(steamCfg).toBeDefined();
        expect(steamCfg?.preferredPlatformId).toBe('steam');
        expect(steamCfg?.launchMethod).toBe('storefront_uri');
        expect(steamCfg?.wineBottleName).toBe('SteamBottle');
        expect(steamCfg?.crossoverGraphicsBackend).toBe('dxmt');
        expect(steamCfg?.crossoverHighResolutionMode).toBe(false);
        expect(steamCfg?.customExecutablePath).toBeUndefined();

        // 4. Verify on-disk persistence and launcherEngine.resolvePlatformLaunchConfig isolation
        const diskConfigs = launcherEngine.getGameLaunchConfigs({ userDataDir });
        const savedDiskEntry = diskConfigs[multiStoreGame.id];
        expect(savedDiskEntry).toBeDefined();
        expect(savedDiskEntry.platformConfigs?.gog).toMatchObject({
          launchMethod: 'compatibility_layer',
          wineBottleName: 'GOGBottle',
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverHighResolutionMode: true,
          customExecutablePath: tempGogExe,
        });
        expect(savedDiskEntry.platformConfigs?.steam).toMatchObject({
          launchMethod: 'storefront_uri',
          wineBottleName: 'SteamBottle',
          crossoverGraphicsBackend: 'dxmt',
          crossoverHighResolutionMode: false,
        });
        expect(savedDiskEntry.platformConfigs?.steam?.customExecutablePath).toBeUndefined();

        const resolvedGogEngineCfg = launcherEngine.resolvePlatformLaunchConfig(
          savedDiskEntry,
          'gog'
        );
        expect(resolvedGogEngineCfg.launchMethod).toBe('compatibility_layer');
        expect(resolvedGogEngineCfg.wineBottleName).toBe('GOGBottle');
        expect(resolvedGogEngineCfg.customExecutablePath).toBe(tempGogExe);

        const resolvedSteamEngineCfg = launcherEngine.resolvePlatformLaunchConfig(
          savedDiskEntry,
          'steam'
        );
        expect(resolvedSteamEngineCfg.launchMethod).toBe('storefront_uri');
        expect(resolvedSteamEngineCfg.wineBottleName).toBe('SteamBottle');
        expect(resolvedSteamEngineCfg.customExecutablePath).toBeUndefined();

        const resolvedUnconfiguredEpic = launcherEngine.resolvePlatformLaunchConfig(
          savedDiskEntry,
          'epic'
        );
        expect(resolvedUnconfiguredEpic.launchMethod).toBe('auto');
        expect(resolvedUnconfiguredEpic.customExecutablePath).toBeUndefined();

        // 5. Verify launcherService.isGameInstalled is true for GOG and false for Steam
        expect(launcherService.isGameInstalled(multiStoreGame, 'gog')).toBe(true);
        expect(launcherService.isGameInstalled(multiStoreGame, 'steam')).toBe(false);
        expect(
          launcherService.getInstalledRecordForGame(multiStoreGame, 'gog')?.executablePath
        ).toBe(tempGogExe);
        expect(
          launcherService.getInstalledRecordForGame(multiStoreGame, 'steam')
        ).toBeUndefined();

        // 6. Verify GameLaunchConfigModal opened with initialPlatformId="gog" loads GOG settings,
        // switching to Steam button swaps all form fields to Steam settings, and saving preserves both in platformConfigs
        const states: any[] = [];
        const effectsRan: boolean[] = [];

        const findElements = (
          node: any,
          predicate: (el: any) => boolean,
          acc: any[] = []
        ): any[] => {
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

        const onSavedMock = vi.fn();
        const renderMultiStoreModal = () => {
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
            const vnode = (GameLaunchConfigModal as any)({
              isOpen: true,
              game: multiStoreGame,
              initialPlatformId: 'gog',
              onClose: vi.fn(),
              onSaved: onSavedMock,
            });
            const html = renderToString(vnode);
            return { vnode, html };
          } finally {
            internals.H = prevH;
          }
        };

        renderMultiStoreModal();
        await new Promise((r) => setTimeout(r, 15));
        const modalGogRender = renderMultiStoreModal();

        // Confirm GOG pill is active and GOG fields are loaded
        const gogPillBtn = findElements(
          modalGogRender.vnode,
          (el) => el.type === 'button' && el.props?.['data-storefront-pill'] === 'gog'
        )[0];
        const steamPillBtn = findElements(
          modalGogRender.vnode,
          (el) => el.type === 'button' && el.props?.['data-storefront-pill'] === 'steam'
        )[0];
        expect(gogPillBtn).toBeDefined();
        expect(steamPillBtn).toBeDefined();
        expect(gogPillBtn.props['aria-pressed']).toBe(true);
        expect(steamPillBtn.props['aria-pressed']).toBe(false);

        const exeInputGog = findElements(
          modalGogRender.vnode,
          (el) =>
            el.type === 'input' &&
            typeof el.props?.placeholder === 'string' &&
            el.props.placeholder.includes('Auto-detected from storefront manifest')
        )[0];
        expect(exeInputGog).toBeDefined();
        expect(exeInputGog.props.value).toBe(tempGogExe);

        const backendSelectGog = findElements(
          modalGogRender.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'Graphics Backend'
        )[0];
        expect(backendSelectGog.props.value).toBe('d3dmetal');

        const retinaSelectGog = findElements(
          modalGogRender.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'High Resolution Mode'
        )[0];
        expect(retinaSelectGog.props.value).toBe('true');

        const bottleSelectGog = findElements(
          modalGogRender.vnode,
          (el) => el.type === 'select' && el.props?.value === 'GOGBottle'
        )[0];
        expect(bottleSelectGog).toBeDefined();

        // Click Steam storefront button -> verify form fields swap to Steam profile
        steamPillBtn.props.onClick();
        const modalSteamRender = renderMultiStoreModal();

        const gogPillAfter = findElements(
          modalSteamRender.vnode,
          (el) => el.type === 'button' && el.props?.['data-storefront-pill'] === 'gog'
        )[0];
        const steamPillAfter = findElements(
          modalSteamRender.vnode,
          (el) => el.type === 'button' && el.props?.['data-storefront-pill'] === 'steam'
        )[0];
        expect(gogPillAfter.props['aria-pressed']).toBe(false);
        expect(steamPillAfter.props['aria-pressed']).toBe(true);

        const exeInputSteam = findElements(
          modalSteamRender.vnode,
          (el) =>
            el.type === 'input' &&
            typeof el.props?.placeholder === 'string' &&
            el.props.placeholder.includes('Auto-detected from storefront manifest')
        )[0];
        expect(exeInputSteam.props.value).toBe('');

        // Because Steam is uninstalled and in 'storefront_uri' mode, compatibility-layer-settings is progressively hidden
        expect(modalSteamRender.html).not.toContain('data-section="compatibility-layer-settings"');

        // Switch Launch Mode on Steam tab to 'compatibility_layer' ('Pre-Configure Compatibility Runner & Bottle') to inspect the pre-configured Steam compatibility settings
        const steamCompatModeBtn = findElements(
          modalSteamRender.vnode,
          (el) =>
            el.type === 'button' &&
            el.props?.['data-launch-mode'] === 'compatibility_layer'
        )[0];
        expect(steamCompatModeBtn).toBeDefined();
        steamCompatModeBtn.props.onClick();

        const modalSteamCompatRender = renderMultiStoreModal();
        expect(modalSteamCompatRender.html).toContain('data-section="compatibility-layer-settings"');

        const backendSelectSteam = findElements(
          modalSteamCompatRender.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'Graphics Backend'
        )[0];
        expect(backendSelectSteam.props.value).toBe('dxmt');

        const retinaSelectSteam = findElements(
          modalSteamCompatRender.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'High Resolution Mode'
        )[0];
        expect(retinaSelectSteam.props.value).toBe('false');

        const bottleSelectSteam = findElements(
          modalSteamCompatRender.vnode,
          (el) => el.type === 'select' && el.props?.value === 'SteamBottle'
        )[0];
        expect(bottleSelectSteam).toBeDefined();

        // Save Configuration from the modal and verify both GOG and Steam profiles remain intact in platformConfigs
        const saveBtn = findElements(
          modalSteamCompatRender.vnode,
          (el) => el.type === 'button' && getTextContent(el).includes('Save Configuration')
        )[0];
        expect(saveBtn).toBeDefined();
        await saveBtn.props.onClick();

        expect(onSavedMock).toHaveBeenCalledTimes(1);
        const savedModalConfig = onSavedMock.mock.calls[0][0];
        expect(savedModalConfig.platformConfigs?.gog).toMatchObject({
          launchMethod: 'compatibility_layer',
          wineBottleName: 'GOGBottle',
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverHighResolutionMode: true,
          customExecutablePath: tempGogExe,
        });
        expect(savedModalConfig.platformConfigs?.steam).toMatchObject({
          launchMethod: 'compatibility_layer',
          wineBottleName: 'SteamBottle',
          crossoverGraphicsBackend: 'dxmt',
          crossoverHighResolutionMode: false,
        });
        expect(savedModalConfig.platformConfigs?.steam?.customExecutablePath).toBeUndefined();

        // 7. Reset only GOG profile -> preserves Steam profile
        await launcherService.resetLaunchConfig(multiStoreGame.id, 'gog');

        expect(launcherService.getLaunchConfig(multiStoreGame.id, 'gog')).toBeUndefined();
        expect(launcherService.isGameInstalled(multiStoreGame, 'gog')).toBe(false);

        const remainingSteamCfg = launcherService.getLaunchConfig(multiStoreGame.id, 'steam');
        expect(remainingSteamCfg).toBeDefined();
        expect(remainingSteamCfg?.launchMethod).toBe('compatibility_layer');
        expect(remainingSteamCfg?.wineBottleName).toBe('SteamBottle');
        expect(remainingSteamCfg?.crossoverGraphicsBackend).toBe('dxmt');

        const diskAfterGogReset = launcherEngine.getGameLaunchConfigs({ userDataDir });
        expect(diskAfterGogReset[multiStoreGame.id]?.platformConfigs?.gog).toBeUndefined();
        expect(diskAfterGogReset[multiStoreGame.id]?.platformConfigs?.steam).toBeDefined();

        // 8. Reset remaining Steam profile -> removes the config entry cleanly from memory and disk
        await launcherService.resetLaunchConfig(multiStoreGame.id, 'steam');

        expect(launcherService.getLaunchConfig(multiStoreGame.id, 'steam')).toBeUndefined();
        expect(launcherService.getLaunchConfig(multiStoreGame.id)).toBeUndefined();

        const diskAfterFullReset = launcherEngine.getGameLaunchConfigs({ userDataDir });
        expect(diskAfterFullReset[multiStoreGame.id]).toBeUndefined();
      } finally {
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
        delete (globalThis as any).window.electronAPI;
      }
    });
  });

  // =========================================================================
  // 27. DYNAMIC & INSTALL-TYPE-RELEVANT LAUNCH & COMPATIBILITY SETTINGS PER STOREFRONT
  // =========================================================================
  describe('27. Dynamic & Install-Type-Relevant Launch & Compatibility Settings per Storefront', () => {
    it('dynamically hides CrossOver/Wine controls for macOS Native (.app) storefronts while revealing them for Windows (.exe) storefronts and adapts CrossOver vs Wine/GPTK rendering sub-panels', async () => {
      const hybridStoreGame: CanonicalGame = {
        id: 'steam-2310-hybrid',
        title: 'Quake',
        sortTitle: 'Quake',
        steamAppId: 2310,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1435827232',
            installed: true,
            installPath: '/Applications/Quake.app',
            executablePath: '/Applications/Quake.app/Contents/MacOS/Quake',
            isWindowsBinaryOnMac: false,
            playtimeMinutes: 45,
          },
          {
            platformId: 'steam',
            platformGameId: '2310',
            installed: true,
            installPath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Quake',
            executablePath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Quake/Quake_x64.exe',
            isWindowsBinaryOnMac: true,
            playtimeMinutes: 120,
          },
        ],
        headerImage: '',
        developers: ['id Software'],
        publishers: ['Bethesda Softworks'],
        genres: ['Action'],
        tags: ['FPS'],
      };

      (globalThis as any).window.electronAPI = {
        saveGameLaunchConfig: async (cfg: any) =>
          launcherEngine.saveGameLaunchConfig(cfg, { userDataDir }),
        getGameLaunchConfigs: async () =>
          launcherEngine.getGameLaunchConfigs({ userDataDir }),
      };

      const mockLayers: CompatibilityLayerInfo[] = [
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          availableBottles: ['Steam', 'Default'],
        },
        {
          id: 'gptk',
          type: 'gptk',
          name: 'Apple Game Porting Toolkit',
          binaryPath:
            '/Users/test/Library/Application Support/heroic/tools/game-porting-toolkit/GPTK-2.0/bin/wine64',
          availableBottles: ['GPTKBottle'],
        },
      ];

      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockLayers);

      try {
        // 1. Verify resolveEffectiveLaunchModePreview for GOG (mac_native_app)
        const gogPreview = launcherService.resolveEffectiveLaunchModePreview(
          hybridStoreGame,
          'gog'
        );
        expect(gogPreview.detectedBuildType).toBe('mac_native_app');
        expect(gogPreview.availableModes).toEqual(['auto', 'direct', 'storefront_uri']);
        expect(gogPreview.availableModes).not.toContain('compatibility_layer');
        expect(gogPreview.visibleSections).toEqual({
          compatibilityLayer: false,
          crossoverRendering: false,
          nativeMacMetalHud: true,
          executableAndArgs: true,
          environmentAndHooks: true,
        });

        // 2. Verify resolveEffectiveLaunchModePreview for Steam (windows_exe_on_mac)
        const steamPreview = launcherService.resolveEffectiveLaunchModePreview(
          hybridStoreGame,
          'steam'
        );
        expect(steamPreview.detectedBuildType).toBe('windows_exe_on_mac');
        expect(steamPreview.availableModes).toEqual([
          'auto',
          'compatibility_layer',
        ]);
        expect(steamPreview.visibleSections).toEqual({
          compatibilityLayer: true,
          crossoverRendering: true,
          nativeMacMetalHud: false,
          executableAndArgs: true,
          environmentAndHooks: true,
        });

        // 3. Render GameLaunchConfigModal with initialPlatformId="gog" (macOS Native .app storefront)
        const states: any[] = [];
        const effectsRan: boolean[] = [];

        const findElements = (
          node: any,
          predicate: (el: any) => boolean,
          acc: any[] = []
        ): any[] => {
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

        const onSavedMock = vi.fn();
        const renderHybridModal = () => {
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
            const vnode = (GameLaunchConfigModal as any)({
              isOpen: true,
              game: hybridStoreGame,
              initialPlatformId: 'gog',
              onClose: vi.fn(),
              onSaved: onSavedMock,
            });
            const html = renderToString(vnode);
            return { vnode, html };
          } finally {
            internals.H = prevH;
          }
        };

        renderHybridModal();
        await new Promise((r) => setTimeout(r, 15));
        const gogRender = renderHybridModal();

        // Verify modal header for macOS Native build
        expect(gogRender.html).toContain('Launch Settings (macOS Native)');

        // Verify GOG native macOS .app does NOT render compatibility layer or CrossOver controls
        expect(gogRender.html).not.toContain(
          'macOS Compatibility Layer (CrossOver / Apple GPTK / Wine)'
        );
        expect(gogRender.html).not.toContain('CrossOver 26 Rendering &amp; Display Settings');
        expect(gogRender.html).not.toContain('aria-label="Graphics Backend"');
        expect(gogRender.html).not.toContain('DLSS (MetalFX Upscaling)');
        expect(gogRender.html).not.toContain('Target Bottle Name');
        expect(gogRender.html).not.toContain('MSync');
        expect(gogRender.html).not.toContain('ESync');
        expect(gogRender.html).not.toContain('DXVK HUD');

        // Verify GOG native macOS .app DOES render native macOS Metal HUD section and only 3 native-relevant launch modes
        expect(gogRender.html).toContain('data-section="native-mac-settings"');
        expect(gogRender.html).toContain('Apple Metal Performance HUD (MTL_HUD_ENABLED=1)');
        expect(gogRender.html).toContain('Auto-Detect Native macOS Launch');
        expect(gogRender.html).toContain('Direct macOS Application (.app / Binary)');
        expect(gogRender.html).toContain('Storefront Client Protocol');
        expect(gogRender.html).not.toContain(
          'Custom Compatibility Runner &amp; Bottle'
        );

        // 4. Click the Steam storefront pill (which has Windows .exe installed on macOS)
        const steamPillBtn = findElements(
          gogRender.vnode,
          (el) => el.type === 'button' && el.props?.['data-storefront-pill'] === 'steam'
        )[0];
        expect(steamPillBtn).toBeDefined();
        steamPillBtn.props.onClick();

        const steamRender = renderHybridModal();
        expect(steamRender.html).toContain('Launch &amp; Compatibility Settings');
        expect(steamRender.html).not.toContain('data-section="native-mac-settings"');
        expect(steamRender.html).toContain('data-section="compatibility-layer-settings"');
        expect(steamRender.html).toContain(
          'macOS Compatibility Layer (CrossOver / Apple GPTK / Wine)'
        );
        expect(steamRender.html).toContain('CrossOver 26 Rendering &amp; Display Settings');
        expect(steamRender.html).toContain('aria-label="Graphics Backend"');
        expect(steamRender.html).toContain('aria-label="High Resolution Mode"');
        expect(steamRender.html).toContain('DLSS (MetalFX Upscaling)');
        expect(steamRender.html).toContain('MSync');
        expect(steamRender.html).toContain('ESync');
        expect(steamRender.html).toContain('DXVK HUD');

        // 5. Switch Compatibility Runner on the Steam storefront to 'gptk'
        const runnerSelect = findElements(
          steamRender.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'Compatibility Runner'
        )[0];
        expect(runnerSelect).toBeDefined();
        runnerSelect.props.onChange({ target: { value: 'gptk' } });

        const gptkRender = renderHybridModal();
        // Verify CrossOver-only Graphics Backend and DLSS hide while Wine/GPTK Display & Sync settings remain visible
        expect(gptkRender.html).not.toContain('CrossOver 26 Rendering &amp; Display Settings');
        expect(gptkRender.html).not.toContain('aria-label="Graphics Backend"');
        expect(gptkRender.html).not.toContain('DLSS (MetalFX Upscaling)');
        expect(gptkRender.html).toContain('Wine / GPTK Display &amp; Synchronization Settings');
        expect(gptkRender.html).toContain('aria-label="High Resolution Mode"');
        expect(gptkRender.html).toContain('MSync');
        expect(gptkRender.html).toContain('ESync');

        // 6. Switch back to GOG (mac_native_app), toggle native Metal HUD on, and click Save Configuration
        const gogPillBtn2 = findElements(
          gptkRender.vnode,
          (el) => el.type === 'button' && el.props?.['data-storefront-pill'] === 'gog'
        )[0];
        expect(gogPillBtn2).toBeDefined();
        gogPillBtn2.props.onClick();

        const gogRender2 = renderHybridModal();
        const nativeSection = findElements(
          gogRender2.vnode,
          (el) => el.props?.['data-section'] === 'native-mac-settings'
        )[0];
        expect(nativeSection).toBeDefined();
        const metalHudToggleBtn = findElements(
          nativeSection,
          (el) => el.type === 'button'
        )[0];
        expect(metalHudToggleBtn).toBeDefined();
        metalHudToggleBtn.props.onClick();

        const gogRender3 = renderHybridModal();
        const saveBtn = findElements(
          gogRender3.vnode,
          (el) => el.type === 'button' && getTextContent(el).includes('Save Configuration')
        )[0];
        expect(saveBtn).toBeDefined();
        await saveBtn.props.onClick();

        expect(onSavedMock).toHaveBeenCalledTimes(1);
        const savedConfig = onSavedMock.mock.calls[0][0];

        // Verify platformConfigs.gog has metalHud: true and no Wine/CrossOver pollution
        expect(savedConfig.platformConfigs?.gog).toBeDefined();
        expect(savedConfig.platformConfigs?.gog?.metalHud).toBe(true);
        expect(savedConfig.platformConfigs?.gog?.compatibilityLayer).toBeUndefined();
        expect(savedConfig.platformConfigs?.gog?.wineBottleName).toBeUndefined();
        expect(savedConfig.platformConfigs?.gog?.crossoverGraphicsBackend).toBeUndefined();

        // Verify platformConfigs.steam retains its compatibility layer settings (with MSync/ESync mutual exclusion)
        expect(savedConfig.platformConfigs?.steam).toBeDefined();
        expect(savedConfig.platformConfigs?.steam?.compatibilityLayer).toBe('gptk');
        expect(savedConfig.platformConfigs?.steam?.wineMsync).toBe(true);
        expect(savedConfig.platformConfigs?.steam?.wineEsync).toBe(false);

        await launcherService.resetLaunchConfig(hybridStoreGame.id);
      } finally {
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
        delete (globalThis as any).window.electronAPI;
      }
    });
  });

  // =========================================================================
  // 28. UNIVERSAL STOREFRONT LAUNCH MANIFEST & EXECUTABLE DISCOVERY
  // =========================================================================
  describe('28. Universal Storefront Launch Manifest & Executable Discovery (Steam appinfo.vdf, Source Engine gameinfo.txt, & Bottle PE Filtering)', () => {
    const buildSyntheticSteamAppInfoVdfV29 = (
      appId: number,
      launchEntries: Array<{
        id: string;
        executable: string;
        arguments?: string;
        workingdir?: string;
        type?: string;
        oslist?: string;
      }>
    ): Buffer => {
      const stringTable: string[] = [];
      const getStringIdx = (str: string): number => {
        let idx = stringTable.indexOf(str);
        if (idx === -1) {
          idx = stringTable.length;
          stringTable.push(str);
        }
        return idx;
      };

      const chunks: Buffer[] = [];
      const pushByte = (b: number) => chunks.push(Buffer.from([b]));
      const pushUInt32 = (v: number) => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(v, 0);
        chunks.push(b);
      };
      const pushCString = (s: string) => {
        chunks.push(Buffer.from(s + '\0', 'utf8'));
      };
      const beginObject = (key: string) => {
        pushByte(0x00);
        pushUInt32(getStringIdx(key));
      };
      const endObject = () => {
        pushByte(0x08);
      };
      const writeStringProp = (key: string, val: string) => {
        pushByte(0x01);
        pushUInt32(getStringIdx(key));
        pushCString(val);
      };

      beginObject('appinfo');
      beginObject('config');
      beginObject('launch');
      for (const entry of launchEntries) {
        beginObject(entry.id);
        writeStringProp('executable', entry.executable);
        if (entry.arguments) writeStringProp('arguments', entry.arguments);
        if (entry.workingdir) writeStringProp('workingdir', entry.workingdir);
        if (entry.type) writeStringProp('type', entry.type);
        if (entry.oslist) {
          beginObject('config');
          writeStringProp('oslist', entry.oslist);
          endObject();
        }
        endObject();
      }
      endObject(); // launch
      endObject(); // config
      endObject(); // appinfo
      endObject(); // root

      const payloadBuf = Buffer.concat(chunks);
      const entryMetaBuf = Buffer.alloc(60, 0); // 60 bytes metadata in v28/v29
      const entryHeaderBuf = Buffer.alloc(8);
      entryHeaderBuf.writeUInt32LE(appId, 0);
      entryHeaderBuf.writeUInt32LE(entryMetaBuf.length + payloadBuf.length, 4);

      const sentinelBuf = Buffer.alloc(4, 0); // appId = 0 terminator

      const entriesBlock = Buffer.concat([
        entryHeaderBuf,
        entryMetaBuf,
        payloadBuf,
        sentinelBuf,
      ]);

      const headerBuf = Buffer.alloc(16);
      headerBuf.writeUInt32LE(0x07564429, 0); // v29 magic
      headerBuf.writeUInt32LE(1, 4); // universe
      const strTableOffset = 16 + entriesBlock.length;
      headerBuf.writeBigInt64LE(BigInt(strTableOffset), 8);

      const strCountBuf = Buffer.alloc(4);
      strCountBuf.writeUInt32LE(stringTable.length, 0);
      const strBuffers = stringTable.map((s) => Buffer.from(s + '\0', 'utf8'));

      return Buffer.concat([headerBuf, entriesBlock, strCountBuf, ...strBuffers]);
    };

    const createValidWinPeBuffer = (is64Bit = false): Buffer => {
      const buf = Buffer.alloc(512, 0);
      buf.write('MZ', 0, 'ascii');
      buf.writeUInt32LE(0x80, 0x3c); // e_lfanew = 0x80
      buf.write('PE\0\0', 0x80, 'ascii');
      buf.writeUInt16LE(is64Bit ? 0x8664 : 0x014c, 0x84);
      buf.writeUInt16LE(2, 0x80 + 24 + 68); // Subsystem = Windows GUI (2)
      return buf;
    };

    it('resolves Portal (hl2.exe + "-game portal -steam") via binary appinfo.vdf v29, Source Engine gameinfo.txt fallback, Bottle PE Filtering (ignoring bin/itemtest.com & bin/hammer.exe), and spawns CrossOver with ["-game", "portal", "-steam"]', async () => {
      const tempDir = path.join(tmpRoot, 'universal-portal-manifest-discovery');
      const tempHome = path.join(tempDir, 'home');
      const tempUserData = path.join(tempDir, 'userdata');
      fs.mkdirSync(tempHome, { recursive: true });
      fs.mkdirSync(tempUserData, { recursive: true });

      const bottleDir = path.join(
        tempHome,
        'Library/Application Support/CrossOver/Bottles/OneLauncher'
      );
      const bottleSteamRoot = path.join(bottleDir, 'drive_c/Program Files (x86)/Steam');
      const bottleSteamApps = path.join(bottleSteamRoot, 'steamapps');
      const portalInstallDir = path.join(bottleSteamApps, 'common/Portal');
      fs.mkdirSync(portalInstallDir, { recursive: true });

      // 1. Populate Portal directory inside CrossOver bottle with:
      // - hl2.exe (valid Windows GUI PE binary)
      // - bin/itemtest.com (executable permissions 0o755 + MZ header — must NEVER be picked)
      // - bin/hammer.exe (SDK level editor — must NEVER be picked)
      // - portal/gameinfo.txt (Source Engine mod manifest)
      const hl2Exe = path.join(portalInstallDir, 'hl2.exe');
      const itemtestCom = path.join(portalInstallDir, 'bin/itemtest.com');
      const hammerExe = path.join(portalInstallDir, 'bin/hammer.exe');
      const gameInfoTxt = path.join(portalInstallDir, 'portal/gameinfo.txt');

      fs.mkdirSync(path.dirname(hl2Exe), { recursive: true });
      fs.writeFileSync(hl2Exe, createValidWinPeBuffer(false), { mode: 0o755 });

      fs.mkdirSync(path.dirname(itemtestCom), { recursive: true });
      fs.writeFileSync(itemtestCom, createValidWinPeBuffer(false), { mode: 0o755 });
      fs.writeFileSync(hammerExe, createValidWinPeBuffer(false), { mode: 0o755 });

      writeTempFile(
        gameInfoTxt,
        `"GameInfo"\n{\n\tgame\t"Portal"\n\ttype\tsingleplayer_only\n}\n`
      );

      // Verify findPrimaryExecutable selects hl2.exe with isWindowsBinaryOnMac: true and ignores bin/itemtest.com & bin/hammer.exe
      launcherEngine.invalidateScanCaches();
      const primaryDiscovered = launcherEngine.findPrimaryExecutable(portalInstallDir, {
        platform: 'darwin',
        hintName: 'Portal',
      });
      expect(primaryDiscovered.executablePath).toBe(hl2Exe);
      expect(primaryDiscovered.isWindowsBinaryOnMac).toBe(true);
      expect(primaryDiscovered.executablePath).not.toContain('itemtest.com');
      expect(primaryDiscovered.executablePath).not.toContain('hammer.exe');

      // Verify resolveDefaultEngineLaunchArguments discovers "-game portal -steam" from portal/gameinfo.txt
      const engineDefaultArgs = launcherEngine.resolveDefaultEngineLaunchArguments(
        portalInstallDir,
        hl2Exe
      );
      expect(engineDefaultArgs).toBe('-game portal -steam');

      // 2. Write synthetic binary Steam appinfo.vdf (v29 0x07564429) and appmanifest_400.acf
      const appinfoVdfPath = path.join(bottleSteamRoot, 'appcache/appinfo.vdf');
      fs.mkdirSync(path.dirname(appinfoVdfPath), { recursive: true });
      const vdfBuffer = buildSyntheticSteamAppInfoVdfV29(400, [
        {
          id: '0',
          executable: 'hl2.exe',
          arguments: '-game portal -steam',
          type: 'default',
          oslist: 'windows',
        },
        {
          id: '1',
          executable: 'bin\\hammer.exe',
          type: 'tool',
          oslist: 'windows',
        },
      ]);
      fs.writeFileSync(appinfoVdfPath, vdfBuffer);

      writeTempFile(
        path.join(bottleSteamApps, 'appmanifest_400.acf'),
        `"AppState"
{
  "appid" "400"
  "Universe" "1"
  "name" "Portal"
  "StateFlags" "4"
  "installdir" "Portal"
  "SizeOnDisk" "4347052354"
  "buildid" "19017868"
}`
      );

      launcherEngine.invalidateScanCaches();
      const appInfoSpec = launcherEngine.resolveSteamAppInfoLaunchSpec(
        bottleSteamApps,
        400,
        portalInstallDir,
        { platform: 'darwin' }
      );
      expect(appInfoSpec).not.toBeNull();
      expect(appInfoSpec.executablePath).toBe(hl2Exe);
      expect(appInfoSpec.launchArguments).toBe('-game portal -steam');
      expect(appInfoSpec.isWindowsBinaryOnMac).toBe(true);

      // Verify scanAllInstalledGames populates executablePath = hl2.exe and launchArguments = "-game portal -steam"
      const scanRes = launcherEngine.scanAllInstalledGames({
        platform: 'darwin',
        homedir: tempHome,
        userDataDir: tempUserData,
        forceRefresh: true,
      });
      expect(scanRes.success).toBe(true);
      const scannedPortal = scanRes.installedGames.find(
        (g: any) => g.platformId === 'steam' && String(g.platformGameId) === '400'
      );
      expect(scannedPortal).toBeDefined();
      expect(scannedPortal.executablePath).toBe(hl2Exe);
      expect(scannedPortal.launchArguments).toBe('-game portal -steam');
      expect(scannedPortal.isWindowsBinaryOnMac).toBe(true);

      // 3. Verify launchGame heals a stale/corrupted executablePath (bin/itemtest.com) to hl2.exe
      // and spawns CrossOver wine with [hl2.exe, "-game", "portal", "-steam"] without requiring custom user launch arguments
      const argsDumpFile = path.join(tempDir, 'crossover-portal-args.json');
      const mockCrossoverWine = path.join(
        tempHome,
        'Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'
      );
      writeTempFile(
        mockCrossoverWine,
        `#!/bin/sh
printf '{"exe":"%s","arg1":"%s","arg2":"%s","arg3":"%s","CX_BOTTLE":"%s","SteamAppId":"%s"}\\n' "$1" "$2" "$3" "$4" "$CX_BOTTLE" "$SteamAppId" > "${argsDumpFile}"
sleep 1
`,
        0o755
      );

      const launchRes = await launcherEngine.launchGame(
        {
          gameId: 'steam-400',
          title: 'Portal',
          platformId: 'steam',
          platformGameId: '400',
          steamAppId: 400,
          installPath: portalInstallDir,
          executablePath: itemtestCom, // Intentionally pass stale/bad .com binary to verify self-healing
          isWindowsBinaryOnMac: false,
        },
        {
          platform: 'darwin',
          homedir: tempHome,
          userDataDir: tempUserData,
        }
      );

      expect(launchRes.success).toBe(true);
      expect(launchRes.session).toBeDefined();
      expect(launchRes.session.executablePath).toBe(hl2Exe);
      expect(launchRes.session.launchMethod).toBe('compatibility_layer:crossover');

      for (let i = 0; i < 20 && !fs.existsSync(argsDumpFile); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(fs.existsSync(argsDumpFile)).toBe(true);
      const spawned = JSON.parse(fs.readFileSync(argsDumpFile, 'utf8'));
      expect(spawned.exe).toBe(hl2Exe);
      expect([spawned.arg1, spawned.arg2, spawned.arg3]).toEqual(['-game', 'portal', '-steam']);
      expect(spawned.CX_BOTTLE).toBe('OneLauncher');
      expect(spawned.SteamAppId).toBe('400');

      await launcherEngine.stopGame({ gameId: 'steam-400' });
    });
  });

  // =========================================================================
  // 29. COMPLETE CROSSOVER STEAM BOTTLE UNINSTALL & ORPHANED MANIFEST SELF-HEALING
  // =========================================================================
  describe('29. Complete CrossOver Steam Bottle Uninstall & Orphaned Manifest Self-Healing (Bug 1 & Bug 2)', () => {
    it('Bug 1 & Bug 2: uninstallGame removes CrossOver bottle appmanifest_*.acf, common/<installdir>, libraryfolders.vdf app entry, Windows .url / cxmenu wrappers, and ~/Applications/CrossOver/<Game>.app without launching macOS Steam or deleting Steam.app', async () => {
      const tempDir = path.join(tmpRoot, 'crossover-bottle-uninstall-2320');
      const tmpHome = path.join(tempDir, 'home');
      const tmpUserData = path.join(tempDir, 'userdata');
      fs.mkdirSync(tmpHome, { recursive: true });
      fs.mkdirSync(tmpUserData, { recursive: true });

      const bottleRoot = path.join(
        tmpHome,
        'Library/Application Support/CrossOver/Bottles/OneLauncher'
      );
      const steamappsDir = path.join(
        bottleRoot,
        'drive_c/Program Files (x86)/Steam/steamapps'
      );
      const acfPath = path.join(steamappsDir, 'appmanifest_2320.acf');
      const gameCommonDir = path.join(steamappsDir, 'common/Quake 2');
      const quakeExePath = path.join(gameCommonDir, 'quake2.exe');
      const libraryFoldersVdfPath = path.join(steamappsDir, 'libraryfolders.vdf');

      writeTempFile(
        acfPath,
        `"AppState"
{
  "appid" "2320"
  "Universe" "1"
  "name" "Quake II"
  "StateFlags" "4"
  "installdir" "Quake 2"
  "SizeOnDisk" "6677996420"
}`
      );
      writeTempFile(quakeExePath, 'MZ-quake2-64bit-pe-executable', 0o755);
      writeTempFile(
        libraryFoldersVdfPath,
        `"libraryfolders"
{
  "0"
  {
    "path" "C:\\\\Program Files (x86)\\\\Steam"
    "apps"
    {
      "2320"		"6677996420"
      "400"		"4347052354"
    }
  }
}
`
      );

      const desktopUrlPath = path.join(
        bottleRoot,
        'drive_c/users/crossover/Desktop/Quake II.url'
      );
      const startMenuUrlPath = path.join(
        bottleRoot,
        'drive_c/users/crossover/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Steam/Quake II.url'
      );
      const cxmenuUrlPath = path.join(
        bottleRoot,
        'desktopdata/cxmenu/StartMenu.C^5Fusers_crossover_Desktop/Quake II.url'
      );

      writeTempFile(
        desktopUrlPath,
        `[InternetShortcut]\nURL=steam://rungameid/2320\nIconIndex=0\n`
      );
      writeTempFile(
        startMenuUrlPath,
        `[InternetShortcut]\nURL=steam://rungameid/2320\nIconIndex=0\n`
      );
      writeTempFile(
        cxmenuUrlPath,
        `#!/bin/sh\nexec "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine" --bottle "OneLauncher" --start "C:\\\\users\\\\crossover\\\\Desktop\\\\Quake II.url" "$@"\n`,
        0o755
      );

      const quakeAppDir = path.join(tmpHome, 'Applications/CrossOver/Steam/Quake II.app');
      const quakePlistPath = path.join(quakeAppDir, 'Contents/Info.plist');
      writeTempFile(
        quakePlistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.codeweavers.CrossOverHelper.quake2</string>
  <key>CFBundleName</key>
  <string>Quake II</string>
  <key>CXHelperAppBottleName</key>
  <string>OneLauncher</string>
  <key>CrossOverHelperCommand</key>
  <string>${cxmenuUrlPath}</string>
</dict>
</plist>`
      );

      const steamAppDir = path.join(tmpHome, 'Applications/CrossOver/Steam/Steam.app');
      const steamPlistPath = path.join(steamAppDir, 'Contents/Info.plist');
      writeTempFile(
        steamPlistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.codeweavers.CrossOverHelper.steam</string>
  <key>CFBundleName</key>
  <string>Steam</string>
  <key>CXHelperAppBottleName</key>
  <string>OneLauncher</string>
</dict>
</plist>`
      );

      const mockOpenExternal = vi.fn();
      const prevOpenedLen = launcherEngine.openedExternalUris.length;

      const uninstallRes = await launcherEngine.uninstallGame(
        {
          gameId: 'steam-2320',
          platformId: 'steam',
          platformGameId: '2320',
          steamAppId: 2320,
          title: 'Quake II',
          installPath: gameCommonDir,
        },
        {
          platform: 'darwin',
          homedir: tmpHome,
          userDataDir: tmpUserData,
          openExternal: mockOpenExternal,
          onOpenExternal: mockOpenExternal,
        }
      );

      expect(uninstallRes.success).toBe(true);
      // Verify macOS Steam is NEVER launched via steam://uninstall/2320
      expect(mockOpenExternal).not.toHaveBeenCalled();
      expect(launcherEngine.openedExternalUris.slice(prevOpenedLen)).not.toContain(
        'steam://uninstall/2320'
      );

      // Verify manifest, common/<installdir>, libraryfolders.vdf entry, and CrossOver shortcuts are removed
      expect(fs.existsSync(acfPath)).toBe(false);
      expect(fs.existsSync(gameCommonDir)).toBe(false);
      const updatedVdf = fs.readFileSync(libraryFoldersVdfPath, 'utf8');
      expect(updatedVdf).not.toContain('"2320"');
      expect(updatedVdf).toContain('"400"');

      expect(fs.existsSync(desktopUrlPath)).toBe(false);
      expect(fs.existsSync(startMenuUrlPath)).toBe(false);
      expect(fs.existsSync(cxmenuUrlPath)).toBe(false);
      expect(fs.existsSync(quakeAppDir)).toBe(false);
      // Verify Steam.app is preserved
      expect(fs.existsSync(steamAppDir)).toBe(true);

      // Verify subsequent scan returns 0 installed records for 2320
      const scanRes = launcherEngine.scanAllInstalledGames({
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        forceRefresh: true,
      });
      expect(scanRes.success).toBe(true);
      expect(
        scanRes.installedGames.filter((g: any) => String(g.platformGameId) === '2320')
      ).toHaveLength(0);
      expect(scanRes.installedSteamAppIds).not.toContain(2320);
    });

    it('Bug 2: scanAllInstalledGames self-heals orphaned CrossOver bottle appmanifest_*.acf and save-only common/<installdir> leftovers with zero executables', () => {
      const tempDir = path.join(tmpRoot, 'crossover-bottle-self-heal-2320');
      const tmpHome = path.join(tempDir, 'home');
      const tmpUserData = path.join(tempDir, 'userdata');
      fs.mkdirSync(tmpHome, { recursive: true });
      fs.mkdirSync(tmpUserData, { recursive: true });

      const bottleRoot = path.join(
        tmpHome,
        'Library/Application Support/CrossOver/Bottles/OneLauncher'
      );
      const steamappsDir = path.join(
        bottleRoot,
        'drive_c/Program Files (x86)/Steam/steamapps'
      );
      const acfPath = path.join(steamappsDir, 'appmanifest_2320.acf');
      const gameCommonDir = path.join(steamappsDir, 'common/Quake 2');
      const saveFileOnly = path.join(gameCommonDir, 'baseq2/save/game.ssv');
      const cfgFileOnly = path.join(gameCommonDir, 'baseq2/q2config.cfg');
      const libraryFoldersVdfPath = path.join(steamappsDir, 'libraryfolders.vdf');

      writeTempFile(
        acfPath,
        `"AppState"
{
  "appid" "2320"
  "Universe" "1"
  "name" "Quake II"
  "StateFlags" "4"
  "installdir" "Quake 2"
  "SizeOnDisk" "6677996420"
}`
      );
      // Only cloud save/config files left behind after in-Steam uninstall (zero .exe or .app)
      writeTempFile(saveFileOnly, 'save-state-bytes');
      writeTempFile(cfgFileOnly, 'bind TAB "inven"');
      writeTempFile(
        libraryFoldersVdfPath,
        `"libraryfolders"
{
  "0"
  {
    "path" "C:\\\\Program Files (x86)\\\\Steam"
    "apps"
    {
      "2320"		"6677996420"
    }
  }
}
`
      );

      const quakeAppDir = path.join(tmpHome, 'Applications/CrossOver/Steam/Quake II.app');
      writeTempFile(
        path.join(quakeAppDir, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.codeweavers.CrossOverHelper.quake2</string>
  <key>CFBundleName</key>
  <string>Quake II</string>
  <key>CXHelperAppBottleName</key>
  <string>OneLauncher</string>
</dict>
</plist>`
      );

      const steamAppDir = path.join(tmpHome, 'Applications/CrossOver/Steam/Steam.app');
      writeTempFile(
        path.join(steamAppDir, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.codeweavers.CrossOverHelper.steam</string>
  <key>CFBundleName</key>
  <string>Steam</string>
</dict>
</plist>`
      );

      launcherEngine.invalidateScanCaches();
      const scanRes = launcherEngine.scanAllInstalledGames({
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        forceRefresh: true,
      });

      expect(scanRes.success).toBe(true);
      // 2320 must NOT be reported as installed
      expect(
        scanRes.installedGames.filter((g: any) => String(g.platformGameId) === '2320')
      ).toHaveLength(0);
      expect(scanRes.installedSteamAppIds).not.toContain(2320);

      // Orphaned bottle manifest, save-only directory, libraryfolders.vdf entry, and Quake II.app shortcut are self-healed
      expect(fs.existsSync(acfPath)).toBe(false);
      expect(fs.existsSync(gameCommonDir)).toBe(false);
      expect(fs.readFileSync(libraryFoldersVdfPath, 'utf8')).not.toContain('"2320"');
      expect(fs.existsSync(quakeAppDir)).toBe(false);
      expect(fs.existsSync(steamAppDir)).toBe(true);
    });
  });

  // =========================================================================
  // 30. HOLISTIC LAUNCH & COMPATIBILITY SETTINGS UPGRADE: WHISKY REMOVAL,
  //     DYNAMIC LAUNCH MODES, & MISSING COMPATIBILITY RUNNER INSTALLER
  // =========================================================================
  describe('30. Holistic Launch & Compatibility Settings Upgrade: Whisky Removal, Dynamic Launch Modes & Missing Compatibility Runner Installer', () => {
    it('1. verifies discontinued Whisky is completely removed from CompatibilityLayerType, detectCompatibilityLayers, GameLaunchConfigModal, and README.md while legacy saved configs normalize whisky -> crossover', () => {
      const repoRoot = path.resolve(__dirname, '..');
      const readmeText = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
      const contractText = fs.readFileSync(
        path.join(repoRoot, 'src/contracts/launcher.ts'),
        'utf8'
      );
      const modalText = fs.readFileSync(
        path.join(repoRoot, 'src/components/Launcher/GameLaunchConfigModal.tsx'),
        'utf8'
      );

      expect(readmeText).not.toMatch(/whisky/i);
      expect(contractText).not.toMatch(/whisky/i);
      expect(modalText).not.toMatch(/whisky/i);

      // Verify legacy config migration normalizes 'whisky' -> 'crossover' in both engine and service
      const legacyDir = path.join(tmpRoot, 'legacy-whisky-migration');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, 'one_launcher_configs.json'),
        JSON.stringify({
          'steam-1091500': {
            gameId: 'steam-1091500',
            compatibilityLayer: 'whisky',
            platformConfigs: {
              steam: {
                launchMethod: 'compatibility_layer',
                compatibilityLayer: 'whisky',
              },
            },
          },
        }),
        'utf8'
      );

      const migratedDiskConfigs = launcherEngine.getGameLaunchConfigs({ userDataDir: legacyDir });
      expect(migratedDiskConfigs['steam-1091500'].compatibilityLayer).toBe('crossover');
      expect(migratedDiskConfigs['steam-1091500'].platformConfigs.steam.compatibilityLayer).toBe(
        'crossover'
      );
    });

    it('2 & 3. verifies compat-runner-select excludes macOS Native and Whisky (offering only crossover, crossover_preview, gptk, wine) and enforces strict dynamic availableModes across windows_exe_on_mac, mac_native_app, and win32', () => {
      const winExeOnMacGame: CanonicalGame = {
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        steamAppId: 1091500,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Cyberpunk 2077',
            executablePath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const macNativeAppGame: CanonicalGame = {
        id: 'gog-baldur3',
        title: "Baldur's Gate 3",
        sortTitle: "Baldur's Gate 3",
        platforms: [
          {
            platformId: 'gog',
            platformGameId: 'bg3',
            installed: true,
            installPath: "/Applications/Baldur's Gate 3.app",
            executablePath: "/Applications/Baldur's Gate 3.app/Contents/MacOS/BaldursGate3",
            isWindowsBinaryOnMac: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      // A. macOS with Windows .exe installed (windows_exe_on_mac) -> ONLY ['auto', 'compatibility_layer']
      const winOnMacPreview = launcherService.resolveEffectiveLaunchModePreview(
        winExeOnMacGame,
        'steam'
      );
      expect(winOnMacPreview.detectedBuildType).toBe('windows_exe_on_mac');
      expect(winOnMacPreview.availableModes).toEqual(['auto', 'compatibility_layer']);
      expect(winOnMacPreview.availableModes).not.toContain('direct');
      expect(winOnMacPreview.availableModes).not.toContain('storefront_uri');

      // B. macOS with Native macOS .app installed (mac_native_app) -> ONLY ['auto', 'direct', 'storefront_uri']
      const macNativePreview = launcherService.resolveEffectiveLaunchModePreview(
        macNativeAppGame,
        'gog'
      );
      expect(macNativePreview.detectedBuildType).toBe('mac_native_app');
      expect(macNativePreview.availableModes).toEqual(['auto', 'direct', 'storefront_uri']);
      expect(macNativePreview.availableModes).not.toContain('compatibility_layer');

      // C. Windows (win32) -> ONLY ['auto', 'direct', 'storefront_uri']
      (globalThis as any).window.electronAPI = { platform: 'win32' };
      try {
        const win32Preview = launcherService.resolveEffectiveLaunchModePreview(
          winExeOnMacGame,
          'steam'
        );
        expect(win32Preview.detectedBuildType).toBe('windows_native');
        expect(win32Preview.availableModes).toEqual(['auto', 'direct', 'storefront_uri']);
        expect(win32Preview.availableModes).not.toContain('compatibility_layer');
      } finally {
        delete (globalThis as any).window.electronAPI;
      }
    });

    it('4. renders Runner Details & Status Card and Missing Runner Installer Callout in GameLaunchConfigModal and executes installCompatibilityLayer via Homebrew / official download URL', async () => {
      const winExeOnMacGame: CanonicalGame = {
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        steamAppId: 1091500,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Cyberpunk 2077',
            executablePath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const onlyCrossoverDetected: CompatibilityLayerInfo[] = [
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          availableBottles: ['Steam', 'Default'],
        },
      ];

      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(onlyCrossoverDetected);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(onlyCrossoverDetected);

      const states: any[] = [];
      const effectsRan: boolean[] = [];

      const findElements = (
        node: any,
        predicate: (el: any) => boolean,
        acc: any[] = []
      ): any[] => {
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

      const renderModal = () => {
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
          const vnode = (GameLaunchConfigModal as any)({
            isOpen: true,
            game: winExeOnMacGame,
            initialPlatformId: 'steam',
            onClose: vi.fn(),
          });
          const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      try {
        renderModal();
        await new Promise((r) => setTimeout(r, 15));
        const r1 = renderModal();

        // 1. Verify <select data-testid="compat-runner-select"> options:
        // Must contain ONLY crossover, crossover_preview, gptk, wine (never 'native' or 'whisky')
        const runnerSelect = findElements(
          r1.vnode,
          (el) => el.type === 'select' && el.props?.['data-testid'] === 'compat-runner-select'
        )[0];
        expect(runnerSelect).toBeDefined();
        const optionNodes = findElements(runnerSelect, (el) => el.type === 'option');
        const optionValues = optionNodes.map((o) => o.props.value);
        expect(optionValues).toEqual(['crossover', 'crossover_preview', 'gptk', 'wine']);
        expect(optionValues).not.toContain('native');
        expect(optionValues).not.toContain('whisky');

        // 2. When 'crossover' (installed) is selected, runner-details-card shows Installed & Ready
        expect(r1.html).toContain('data-testid="runner-details-card"');
        expect(r1.html).toContain('Installed &amp; Ready');
        expect(r1.html).not.toContain('data-testid="runner-not-installed-callout"');

        // 3. Switch runner to uninstalled 'wine' -> renders runner-not-installed-callout + Homebrew installer button + WineHQ guide button
        runnerSelect.props.onChange({ target: { value: 'wine' } });
        const rWine = renderModal();
        expect(rWine.html).toContain('data-testid="runner-details-card"');
        expect(rWine.html).toContain('data-testid="runner-not-installed-callout"');
        expect(rWine.html).toContain('Runner Not Installed on This Mac');
        expect(rWine.html).toContain('Install Open-Source Wine Automatically (Homebrew)');
        expect(rWine.html).toContain('Open Official WineHQ macOS Guide');
        expect(rWine.html).toContain('Re-Scan Installed Runners');
        expect(rWine.html).toContain('brew install --cask --no-quarantine wine-stable');

        // 4. Switch runner to uninstalled 'gptk' -> renders runner-not-installed-callout + Open Apple GPTK Downloads button
        const runnerSelect2 = findElements(
          rWine.vnode,
          (el) => el.type === 'select' && el.props?.['data-testid'] === 'compat-runner-select'
        )[0];
        runnerSelect2.props.onChange({ target: { value: 'gptk' } });
        const rGptk = renderModal();
        expect(rGptk.html).toContain('data-testid="runner-details-card"');
        expect(rGptk.html).toContain('data-testid="runner-not-installed-callout"');
        expect(rGptk.html).toContain('Open Apple GPTK Downloads');
        expect(rGptk.html).toContain('Re-Scan Installed Runners');

        // 5. Verify launcherEngine.installCompatibilityLayer & launcherService.installCompatibilityLayer
        const installHome = path.join(tmpRoot, 'runner-install-home');
        fs.mkdirSync(installHome, { recursive: true });
        const wineInstalledBin = path.join(
          installHome,
          'Applications/Wine Stable.app/Contents/Resources/wine/bin/wine64'
        );
        const execBrewCalls: Array<{ bin: string; args: string[] }> = [];

        const engineBrewRes = await launcherEngine.installCompatibilityLayer(
          { runnerType: 'wine', mode: 'brew' },
          {
            platform: 'darwin',
            homedir: installHome,
            onExecBrew: async (bin: string, args: string[]) => {
              execBrewCalls.push({ bin, args });
              writeTempFile(wineInstalledBin, '#!/bin/sh\necho "Wine 9.0"\n', 0o755);
            },
          }
        );

        expect(execBrewCalls).toHaveLength(1);
        expect(execBrewCalls[0].args).toEqual([
          'install',
          '--cask',
          '--no-quarantine',
          'wine-stable',
        ]);
        expect(engineBrewRes.success).toBe(true);
        expect(engineBrewRes.installed).toBe(true);
        expect(engineBrewRes.layers.some((l: any) => l.type === 'wine')).toBe(true);

        // Verify launcherService.installCompatibilityLayer invokes electronAPI.installCompatibilityLayer and refreshes layers
        const ipcInstallSpy = vi.fn().mockResolvedValue(engineBrewRes);
        (globalThis as any).window.electronAPI = {
          installCompatibilityLayer: ipcInstallSpy,
        };
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();

        const svcRes = await launcherService.installCompatibilityLayer('wine', 'brew');
        expect(ipcInstallSpy).toHaveBeenCalledWith({ runnerType: 'wine', mode: 'brew' });
        expect(svcRes.success).toBe(true);
        expect(svcRes.installed).toBe(true);
        expect(launcherService.getCompatibilityLayers().some((l) => l.type === 'wine')).toBe(
          true
        );
      } finally {
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
        delete (globalThis as any).window.electronAPI;
      }
    });
  });

  // =========================================================================
  // 29. CROSSOVER PREVIEW BOTTLE COMPATIBILITY & RUNNER VERSION / UPDATE MANAGEMENT
  // =========================================================================
  describe('29. CrossOver Preview Bottle Compatibility & Runner Version / Update Management', () => {
    it('Bug 1 Regression: validates bottles via isValidBottleDirectory, resolves crossover_preview bottlesDir to shared CrossOver/Bottles when CrossOver Preview/Bottles only has an empty OneLauncher folder, and stamps "Preview" = "1" in cxbottle.conf', async () => {
      const testHome = path.join(tmpRoot, 'preview-bottle-fix-home');
      const emptyBottleDir = path.join(testHome, 'EmptyBottle');
      const validBottleDir = path.join(testHome, 'ValidBottle');
      fs.mkdirSync(emptyBottleDir, { recursive: true });
      fs.mkdirSync(path.join(validBottleDir, 'drive_c'), { recursive: true });

      // 1. Verify isValidBottleDirectory returns false for empty directory without drive_c, and true when drive_c exists
      expect(launcherEngine.isValidBottleDirectory(emptyBottleDir, false)).toBe(false);
      expect(launcherEngine.isValidBottleDirectory(validBottleDir, false)).toBe(true);

      // 2. Verify detectCompatibilityLayers resolves crossover_preview's bottlesDir to ~/Library/Application Support/CrossOver/Bottles
      // when ~/Library/Application Support/CrossOver Preview/Bottles only contains an empty uninitialized OneLauncher directory,
      // and cleans up the empty uninitialized OneLauncher folder
      const crossoverPreviewWine = path.join(
        testHome,
        'Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'
      );
      writeTempFile(crossoverPreviewWine, '#!/bin/sh\necho "CrossOver Preview Wine"\n', 0o755);

      const sharedBottlesDir = path.join(
        testHome,
        'Library/Application Support/CrossOver/Bottles'
      );
      const validSharedOneLauncher = path.join(sharedBottlesDir, 'OneLauncher');
      fs.mkdirSync(path.join(validSharedOneLauncher, 'drive_c'), { recursive: true });

      const previewBottlesDir = path.join(
        testHome,
        'Library/Application Support/CrossOver Preview/Bottles'
      );
      const brokenPreviewOneLauncher = path.join(previewBottlesDir, 'OneLauncher');
      fs.mkdirSync(brokenPreviewOneLauncher, { recursive: true });
      expect(fs.existsSync(brokenPreviewOneLauncher)).toBe(true);

      const detected = launcherEngine.detectCompatibilityLayers({
        platform: 'darwin',
        homedir: testHome,
      });

      const previewLayer = detected.find((l: any) => l.type === 'crossover_preview');
      expect(previewLayer).toBeDefined();
      expect(previewLayer.bottlesDir).toBe(sharedBottlesDir);
      expect(previewLayer.availableBottles).toContain('OneLauncher');
      expect(fs.existsSync(brokenPreviewOneLauncher)).toBe(false);

      // 3. Verify applyCrossOverPerGameSettings(bottlePath, config, { isPreviewRunner: true }) writes "Preview" = "1"
      // into [Bottle] section of <bottlePath>/cxbottle.conf (both when creating [Bottle] and when [Bottle] already exists),
      // while preserving [CrossOver] settings (Graphics, HighResolution, DLSS)
      const freshBottleDir = path.join(testHome, 'FreshPreviewBottle');
      fs.mkdirSync(path.join(freshBottleDir, 'drive_c'), { recursive: true });

      launcherEngine.applyCrossOverPerGameSettings(
        freshBottleDir,
        {
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverHighResolutionMode: true,
          crossoverDlss: true,
        },
        { isPreviewRunner: true }
      );

      const createdConf = fs.readFileSync(path.join(freshBottleDir, 'cxbottle.conf'), 'utf8');
      expect(createdConf).toContain('[Bottle]');
      expect(createdConf).toContain('"Preview" = "1"');
      expect(createdConf).toContain('"CX_GRAPHICS_BACKEND" = "d3dmetal"');
      expect(createdConf).toContain('"D3DM_ENABLE_METALFX" = "1"');

      // Now test when [Bottle] and [CrossOver] already exist without "Preview" = "1"
      const existingBottleDir = path.join(testHome, 'ExistingCrossOverBottle');
      fs.mkdirSync(path.join(existingBottleDir, 'drive_c'), { recursive: true });
      const existingConfPath = path.join(existingBottleDir, 'cxbottle.conf');
      fs.writeFileSync(
        existingConfPath,
        `[Bottle]\n"WineArch" = "win64"\n\n[CrossOver]\n"Graphics" = "d3dmetal"\n"HighResolution" = "true"\n"DLSS" = "true"\n\n[EnvironmentVariables]\n"WINEMSYNC" = "1"\n`,
        'utf8'
      );

      launcherEngine.applyCrossOverPerGameSettings(
        existingBottleDir,
        {
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverHighResolutionMode: true,
          crossoverDlss: true,
        },
        { isPreviewRunner: true }
      );

      const updatedConf = fs.readFileSync(existingConfPath, 'utf8');
      expect(updatedConf).toMatch(/\[Bottle\][\s\S]*?"Preview"\s*=\s*"1"/);
      expect(updatedConf).toContain('[CrossOver]');
      expect(updatedConf).toContain('"Graphics" = "d3dmetal"');
      expect(updatedConf).toContain('"HighResolution" = "true"');
      expect(updatedConf).toContain('"DLSS" = "true"');

      // 4. Verify ensureCompatibilityLayerReady with chosenLayer.type === 'crossover_preview' stamps "Preview" = "1"
      // into <bottlePath>/cxbottle.conf on an existing valid bottle
      fs.writeFileSync(
        path.join(validSharedOneLauncher, 'cxbottle.conf'),
        `[Bottle]\n"WineArch" = "win64"\n\n[EnvironmentVariables]\n"WINEMSYNC" = "1"\n`,
        'utf8'
      );

      const env: Record<string, string> = {};
      await launcherEngine.ensureCompatibilityLayerReady(
        previewLayer,
        { wineBottleName: 'OneLauncher', crossoverGraphicsBackend: 'd3dmetal' },
        env,
        { homedir: testHome }
      );

      const readyConf = fs.readFileSync(
        path.join(validSharedOneLauncher, 'cxbottle.conf'),
        'utf8'
      );
      expect(readyConf).toContain('"Preview" = "1"');
      expect(env.CX_BOTTLE).toBe('OneLauncher');
      expect(env.WINEPREFIX).toBe(validSharedOneLauncher);
    });

    it('Enhancement 1 Unit: extracts runner version/build info from Info.plist, compares semantic versions via compareRunnerVersions, and detects update availability via checkCompatibilityLayerUpdates', async () => {
      const verHome = path.join(tmpRoot, 'runner-version-unit-home');
      const appsDir = path.join(verHome, 'Applications');

      // 1. CrossOver.app Info.plist: CFBundleShortVersionString = "26.3", CFBundleVersion = "26.3.0.39832"
      const cxAppDir = path.join(appsDir, 'CrossOver.app');
      const cxWineBin = path.join(cxAppDir, 'Contents/SharedSupport/CrossOver/bin/wine');
      writeTempFile(cxWineBin, '#!/bin/sh\necho "CrossOver Wine"\n', 0o755);
      writeTempFile(
        path.join(cxAppDir, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>26.3</string>
  <key>CFBundleVersion</key>
  <string>26.3.0.39832</string>
</dict>
</plist>`
      );

      const cxInfo = launcherEngine.extractRunnerVersionInfo('crossover', cxWineBin, {
        homedir: verHome,
      });
      expect(cxInfo).toMatchObject({
        version: '26.3.0',
        buildVersion: '26.3.0.39832',
        displayVersion: '26.3.0 (Build 39832)',
      });

      // 2. CrossOver Preview.app Info.plist: CFBundleShortVersionString = "20261006", CFBundleVersion = "27.0.0.41069"
      const cxPreviewAppDir = path.join(appsDir, 'CrossOver Preview.app');
      const cxPreviewWineBin = path.join(
        cxPreviewAppDir,
        'Contents/SharedSupport/CrossOver/bin/wine'
      );
      writeTempFile(cxPreviewWineBin, '#!/bin/sh\necho "CrossOver Preview Wine"\n', 0o755);
      writeTempFile(
        path.join(cxPreviewAppDir, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>20261006</string>
  <key>CFBundleVersion</key>
  <string>27.0.0.41069</string>
</dict>
</plist>`
      );

      const cxPreviewInfo = launcherEngine.extractRunnerVersionInfo(
        'crossover_preview',
        cxPreviewWineBin,
        { homedir: verHome }
      );
      expect(cxPreviewInfo).toMatchObject({
        version: '27.0.0',
        buildVersion: '27.0.0.41069',
        displayVersion: '27.0.0 (Preview 20261006)',
      });

      // 3. Verify compareRunnerVersions
      expect(launcherEngine.compareRunnerVersions('26.3.0', '26.3.1')).toBeLessThan(0);
      expect(launcherEngine.compareRunnerVersions('27.0.0', '27.0.1')).toBeLessThan(0);
      expect(launcherEngine.compareRunnerVersions('26.3.0', '26.3.0')).toBe(0);
      expect(launcherEngine.compareRunnerVersions('27.0.0', '26.3.0')).toBeGreaterThan(0);

      // 4. Verify checkCompatibilityLayerUpdates({ layers })
      const layers = launcherEngine.detectCompatibilityLayers({
        platform: 'darwin',
        homedir: verHome,
      });
      const updates = await launcherEngine.checkCompatibilityLayerUpdates({
        layers,
        mockFeeds: {
          crossover: {
            latestVersion: '26.4.0',
            latestDisplayVersion: '26.4.0 (Build 40100)',
          },
          crossover_preview: {
            latestVersion: '27.0.0',
            latestDisplayVersion: '27.0.0 (Preview 20261006)',
          },
        },
      });

      expect(updates.crossover.installed).toBe(true);
      expect(updates.crossover.installedVersion).toBe('26.3.0');
      expect(updates.crossover.latestVersion).toBe('26.4.0');
      expect(updates.crossover.updateAvailable).toBe(true);

      expect(updates.crossover_preview.installed).toBe(true);
      expect(updates.crossover_preview.installedVersion).toBe('27.0.0');
      expect(updates.crossover_preview.latestVersion).toBe('27.0.0');
      expect(updates.crossover_preview.updateAvailable).toBe(false);
    });

    it('Enhancement 1 UI: renders runner version & update badges in GameLaunchConfigModal, triggers updateCompatibilityLayer on click, and shows Up to Date badge for crossover_preview', async () => {
      const winExeOnMacGame: CanonicalGame = {
        id: 'steam-2320-preview-ui',
        title: 'Quake II',
        sortTitle: 'Quake II',
        steamAppId: 2320,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '2320',
            installed: true,
            installPath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/Quake 2',
            executablePath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/Quake 2/quake2.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const mockLayers: CompatibilityLayerInfo[] = [
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          version: '26.3.0',
          buildVersion: '26.3.0.39832',
          displayVersion: '26.3.0 (Build 39832)',
          bottlesDir: '/Users/test/Library/Application Support/CrossOver/Bottles',
          availableBottles: ['OneLauncher'],
        },
        {
          id: 'crossover_preview',
          type: 'crossover_preview',
          name: 'CrossOver Preview',
          binaryPath:
            '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
          version: '27.0.0',
          buildVersion: '27.0.0.41069',
          displayVersion: '27.0.0 (Preview 20261006)',
          bottlesDir: '/Users/test/Library/Application Support/CrossOver/Bottles',
          availableBottles: ['OneLauncher'],
        },
      ];

      const mockUpdates = {
        crossover: {
          runnerType: 'crossover' as const,
          installed: true,
          installedVersion: '26.3.0',
          installedBuildVersion: '26.3.0.39832',
          installedDisplayVersion: '26.3.0 (Build 39832)',
          latestVersion: '26.4.0',
          latestDisplayVersion: '26.4.0 (Build 40100)',
          updateAvailable: true,
          canAutoUpdate: true,
          checkedAt: new Date().toISOString(),
        },
        crossover_preview: {
          runnerType: 'crossover_preview' as const,
          installed: true,
          installedVersion: '27.0.0',
          installedBuildVersion: '27.0.0.41069',
          installedDisplayVersion: '27.0.0 (Preview 20261006)',
          latestVersion: '27.0.0',
          latestDisplayVersion: '27.0.0 (Preview 20261006)',
          updateAvailable: false,
          canAutoUpdate: true,
          checkedAt: new Date().toISOString(),
        },
      };

      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockLayers);
      const getUpdatesSpy = vi
        .spyOn(launcherService, 'getRunnerUpdates')
        .mockReturnValue(mockUpdates);
      const checkUpdatesSpy = vi
        .spyOn(launcherService, 'checkCompatibilityLayerUpdates')
        .mockResolvedValue(mockUpdates);
      const updateRunnerSpy = vi
        .spyOn(launcherService, 'updateCompatibilityLayer')
        .mockResolvedValue({
          success: true,
          runnerType: 'crossover',
          updated: true,
          previousVersion: '26.3.0',
          newVersion: '26.4.0',
          message: 'Updated CrossOver to v26.4.0.',
          detectedLayers: mockLayers,
        });

      const states: any[] = [];
      const effectsRan: boolean[] = [];

      const findElements = (
        node: any,
        predicate: (el: any) => boolean,
        acc: any[] = []
      ): any[] => {
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

      const renderModal = () => {
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
          const vnode = (GameLaunchConfigModal as any)({
            isOpen: true,
            game: winExeOnMacGame,
            initialPlatformId: 'steam',
            onClose: vi.fn(),
          });
          const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      try {
        renderModal();
        await new Promise((r) => setTimeout(r, 20));
        const r1 = renderModal();

        // 1. Verify <select data-testid="compat-runner-select"> option labels
        const runnerSelect = findElements(
          r1.vnode,
          (el) => el.type === 'select' && el.props?.['data-testid'] === 'compat-runner-select'
        )[0];
        expect(runnerSelect).toBeDefined();
        const optionTexts = findElements(runnerSelect, (el) => el.type === 'option').map((o) =>
          getTextContent(o)
        );
        expect(optionTexts).toContain(
          'CrossOver — v26.3.0 Installed (Recommended) • Update Available (v26.4.0)'
        );
        expect(optionTexts).toContain('CrossOver Preview — v27.0.0 Installed');

        // 2. Verify runner-version-update-row and runner-installed-version show v26.3.0
        expect(r1.html).toContain('data-testid="runner-version-update-row"');
        expect(r1.html).toContain('data-testid="runner-installed-version"');
        expect(r1.html).toContain('Installed Version: v26.3.0');
        expect(r1.html).toContain('26.3.0 (Build 39832)');

        // 3. Verify runner-update-available-badge and update-runner-btn render and trigger updateCompatibilityLayer('crossover')
        expect(r1.html).toContain('data-testid="runner-update-available-badge"');
        expect(r1.html).toContain('Update Available: v26.4.0');
        expect(r1.html).toContain('data-testid="update-runner-btn"');
        expect(r1.html).toContain('Update to v26.4.0');

        const updateBtn = findElements(
          r1.vnode,
          (el) => el.type === 'button' && el.props?.['data-testid'] === 'update-runner-btn'
        )[0];
        expect(updateBtn).toBeDefined();
        await updateBtn.props.onClick();
        expect(updateRunnerSpy).toHaveBeenCalledWith('crossover');

        // 4. Switch to crossover_preview -> shows v27.0.0, runner-up-to-date-badge ("Up to Date (v27.0.0)"), and check-runner-updates-btn
        const runnerSelectAfter = findElements(
          r1.vnode,
          (el) => el.type === 'select' && el.props?.['data-testid'] === 'compat-runner-select'
        )[0];
        runnerSelectAfter.props.onChange({ target: { value: 'crossover_preview' } });

        const rPreview = renderModal();
        expect(rPreview.html).toContain('Installed Version: v27.0.0');
        expect(rPreview.html).toContain('27.0.0 (Preview 20261006)');
        expect(rPreview.html).toContain('data-testid="runner-up-to-date-badge"');
        expect(rPreview.html).toContain('Up to Date (v27.0.0)');
        expect(rPreview.html).toContain('data-testid="check-runner-updates-btn"');
      } finally {
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
        getUpdatesSpy.mockRestore();
        checkUpdatesSpy.mockRestore();
        updateRunnerSpy.mockRestore();
      }
    });
  });

  // ============================================================================
  // 30. Bundled D3DMetal Version Detection & Per-Game D3DMetal Version Switching (4.0b3 vs 3.0)
  // ============================================================================
  describe('30. Bundled D3DMetal Version Detection & Per-Game D3DMetal Version Switching (4.0b3 vs 3.0)', () => {
    it('1. detectBundledD3DMetalVersions & detectCompatibilityLayers extract dual D3DMetal versions (4.0b3 Default + 3.0 Fallback) from CrossOver Preview.app and single D3DMetal 3.0 from CrossOver.app', () => {
      const tempHome = path.join(tmpRoot, 'd3dmetal-detect-home');
      const appsDir = path.join(tempHome, 'Applications');

      // 1a. CrossOver Preview.app with both lib/apple_gptk (4.0b3) and lib/apple_gptk3 (3.0)
      const cxPreviewApp = path.join(appsDir, 'CrossOver Preview.app');
      const cxPreviewBin = path.join(
        cxPreviewApp,
        'Contents/SharedSupport/CrossOver/CrossOver-Hosted Application/wineloader'
      );
      writeTempFile(cxPreviewBin, '#!/bin/sh\nexit 0\n', 0o755);
      writeTempFile(
        path.join(cxPreviewApp, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>20261006</string>
  <key>CFBundleVersion</key>
  <string>27.0.0.41069</string>
</dict>
</plist>`
      );
      writeTempFile(
        path.join(
          cxPreviewApp,
          'Contents/SharedSupport/CrossOver/lib/apple_gptk/external/D3DMetal.framework/Resources/Info.plist'
        ),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>4.0b3</string>
  <key>CFBundleVersion</key>
  <string>400.3</string>
</dict>
</plist>`
      );
      writeTempFile(
        path.join(
          cxPreviewApp,
          'Contents/SharedSupport/CrossOver/lib/apple_gptk3/external/D3DMetal.framework/Resources/Info.plist'
        ),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>3.0</string>
  <key>CFBundleVersion</key>
  <string>300.0</string>
</dict>
</plist>`
      );

      // 1b. CrossOver.app with only lib/apple_gptk (3.0)
      const cxStableApp = path.join(appsDir, 'CrossOver.app');
      const cxStableBin = path.join(
        cxStableApp,
        'Contents/SharedSupport/CrossOver/CrossOver-Hosted Application/wineloader'
      );
      writeTempFile(cxStableBin, '#!/bin/sh\nexit 0\n', 0o755);
      writeTempFile(
        path.join(cxStableApp, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>26.3.0</string>
  <key>CFBundleVersion</key>
  <string>26.3.0.39832</string>
</dict>
</plist>`
      );
      writeTempFile(
        path.join(
          cxStableApp,
          'Contents/SharedSupport/CrossOver/lib/apple_gptk/external/D3DMetal.framework/Resources/Info.plist'
        ),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>3.0</string>
  <key>CFBundleVersion</key>
  <string>300.0</string>
</dict>
</plist>`
      );

      // Direct unit checks on detectBundledD3DMetalVersions
      const previewD3D = launcherEngine.detectBundledD3DMetalVersions(
        'crossover_preview',
        cxPreviewBin,
        cxPreviewApp
      );
      expect(previewD3D).toEqual({
        d3dmetalVersion: '4.0b3',
        availableD3DMetalVersions: [
          {
            id: '4',
            version: '4.0b3',
            label: 'D3DMetal 4.0b3 (Default)',
            isDefault: true,
          },
          {
            id: '3',
            version: '3.0',
            label: 'D3DMetal 3.0 (Fallback)',
            isDefault: false,
          },
        ],
      });

      const stableD3D = launcherEngine.detectBundledD3DMetalVersions(
        'crossover',
        cxStableBin,
        cxStableApp
      );
      expect(stableD3D).toEqual({
        d3dmetalVersion: '3.0',
        availableD3DMetalVersions: [
          {
            id: 'default',
            version: '3.0',
            label: 'D3DMetal 3.0',
            isDefault: true,
          },
        ],
      });

      // End-to-end check via detectCompatibilityLayers
      const layers = launcherEngine.detectCompatibilityLayers({
        platform: 'darwin',
        homedir: tempHome,
        customApplicationsDir: appsDir,
      });
      const previewLayer = layers.find((l: any) => l.type === 'crossover_preview');
      const stableLayer = layers.find((l: any) => l.type === 'crossover');

      expect(previewLayer?.d3dmetalVersion).toBe('4.0b3');
      expect(previewLayer?.availableD3DMetalVersions).toEqual(previewD3D.availableD3DMetalVersions);
      expect(stableLayer?.d3dmetalVersion).toBe('3.0');
      expect(stableLayer?.availableD3DMetalVersions).toEqual(stableD3D.availableD3DMetalVersions);
    });

    it('2. applyCrossOverPerGameSettings writes CX_GRAPHICS_BACKEND_VERSION ("3" or "4") to env and cxbottle.conf and removes it when set to "auto" or non-D3DMetal backend', () => {
      const bottlePath = path.join(tmpRoot, 'd3dmetal-bottle-test');
      fs.mkdirSync(path.join(bottlePath, 'drive_c'), { recursive: true });
      const cxbottleConfPath = path.join(bottlePath, 'cxbottle.conf');
      writeTempFile(
        cxbottleConfPath,
        `[Bottle]\n"WineArch" = "win64"\n"Preview" = "1"\n\n[EnvironmentVariables]\n"WINEMSYNC" = "1"\n`
      );

      // 2a. crossoverD3DMetalVersion = '3' with crossoverGraphicsBackend = 'd3dmetal'
      const env1: Record<string, string> = {};
      launcherEngine.applyCrossOverPerGameSettings(
        { type: 'crossover_preview' },
        {
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverD3DMetalVersion: '3',
        },
        env1,
        bottlePath
      );
      expect(env1.CX_GRAPHICS_BACKEND).toBe('d3dmetal');
      expect(env1.CX_GRAPHICS_BACKEND_VERSION).toBe('3');
      const confAfter3 = fs.readFileSync(cxbottleConfPath, 'utf8');
      expect(confAfter3).toContain('"CX_GRAPHICS_BACKEND" = "d3dmetal"');
      expect(confAfter3).toContain('"CX_GRAPHICS_BACKEND_VERSION" = "3"');

      // 2b. crossoverD3DMetalVersion = '4' with crossoverGraphicsBackend = 'auto'
      const env2: Record<string, string> = { ...env1 };
      launcherEngine.applyCrossOverPerGameSettings(
        { type: 'crossover_preview' },
        {
          crossoverGraphicsBackend: 'auto',
          crossoverD3DMetalVersion: '4',
        },
        env2,
        bottlePath
      );
      expect(env2.CX_GRAPHICS_BACKEND).toBeUndefined();
      expect(env2.CX_GRAPHICS_BACKEND_VERSION).toBe('4');
      const confAfter4 = fs.readFileSync(cxbottleConfPath, 'utf8');
      expect(confAfter4).not.toContain('CX_GRAPHICS_BACKEND" =');
      expect(confAfter4).toContain('"CX_GRAPHICS_BACKEND_VERSION" = "4"');

      // 2c. Reset crossoverD3DMetalVersion back to 'auto' -> removes CX_GRAPHICS_BACKEND_VERSION
      const env3: Record<string, string> = { ...env2 };
      launcherEngine.applyCrossOverPerGameSettings(
        { type: 'crossover_preview' },
        {
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverD3DMetalVersion: 'auto',
        },
        env3,
        bottlePath
      );
      expect(env3.CX_GRAPHICS_BACKEND_VERSION).toBeUndefined();
      const confAfterAuto = fs.readFileSync(cxbottleConfPath, 'utf8');
      expect(confAfterAuto).not.toContain('CX_GRAPHICS_BACKEND_VERSION');

      // 2d. Switching backend to 'dxmt' or 'dxvk' even with crossoverD3DMetalVersion = '3' removes CX_GRAPHICS_BACKEND_VERSION
      const env4: Record<string, string> = { CX_GRAPHICS_BACKEND_VERSION: '3' };
      launcherEngine.applyCrossOverPerGameSettings(
        { type: 'crossover_preview' },
        {
          crossoverGraphicsBackend: 'dxmt',
          crossoverD3DMetalVersion: '3',
        },
        env4,
        bottlePath
      );
      expect(env4.CX_GRAPHICS_BACKEND).toBe('dxmt');
      expect(env4.CX_GRAPHICS_BACKEND_VERSION).toBeUndefined();
      const confAfterDxmt = fs.readFileSync(cxbottleConfPath, 'utf8');
      expect(confAfterDxmt).toContain('"CX_GRAPHICS_BACKEND" = "dxmt"');
      expect(confAfterDxmt).not.toContain('CX_GRAPHICS_BACKEND_VERSION');
    });

    it('3. GameLaunchConfigModal renders runner-d3dmetal-version badge, crossover-d3dmetal-version-section cards (auto / 4 / 3), and persists crossoverD3DMetalVersion: "3" on save', async () => {
      const ReactModule = await import('react');
      const React = ReactModule.default || ReactModule;
      const { renderToString } = await import('react-dom/server');
      const { GameLaunchConfigModal } = await import(
        '../src/components/Launcher/GameLaunchConfigModal'
      );

      const mockLayers: CompatibilityLayerInfo[] = [
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          binaryPath:
            '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/CrossOver-Hosted Application/wineloader',
          appPath: '/Applications/CrossOver.app',
          version: '26.3.0',
          buildVersion: '26.3.0.39832',
          displayVersion: '26.3.0 (Build 39832)',
          d3dmetalVersion: '3.0',
          availableD3DMetalVersions: [
            {
              id: 'default',
              version: '3.0',
              label: 'D3DMetal 3.0',
              isDefault: true,
            },
          ],
          available: true,
          bottlesDir: '/Users/test/Library/Application Support/CrossOver/Bottles',
          availableBottles: ['Steam'],
        },
        {
          id: 'crossover_preview',
          type: 'crossover_preview',
          name: 'CrossOver Preview',
          binaryPath:
            '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/CrossOver-Hosted Application/wineloader',
          appPath: '/Applications/CrossOver Preview.app',
          version: '27.0.0',
          buildVersion: '27.0.0.41069',
          displayVersion: '27.0.0 (Preview 20261006)',
          d3dmetalVersion: '4.0b3',
          availableD3DMetalVersions: [
            {
              id: '4',
              version: '4.0b3',
              label: 'D3DMetal 4.0b3 (Default)',
              isDefault: true,
            },
            {
              id: '3',
              version: '3.0',
              label: 'D3DMetal 3.0 (Fallback)',
              isDefault: false,
            },
          ],
          available: true,
          bottlesDir: '/Users/test/Library/Application Support/CrossOver/Bottles',
          availableBottles: ['Steam'],
        },
      ];

      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockLayers);
      const getUpdatesSpy = vi
        .spyOn(launcherService, 'getRunnerUpdates')
        .mockReturnValue({});
      const checkUpdatesSpy = vi
        .spyOn(launcherService, 'checkCompatibilityLayerUpdates')
        .mockResolvedValue([]);

      const gameId = 'steam-d3dmetal-switch-test';
      const winExeOnMacGame: any = {
        id: gameId,
        title: 'Cyberpunk 2077 D3DMetal Test',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Cyberpunk 2077',
            executablePath:
              '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe',
          },
        ],
      };

      const findElements = (
        node: any,
        predicate: (el: any) => boolean,
        acc: any[] = []
      ): any[] => {
        if (!node) return acc;
        if (Array.isArray(node)) {
          for (const child of node) findElements(child, predicate, acc);
          return acc;
        }
        if (typeof node === 'object') {
          if (predicate(node)) acc.push(node);
          if (typeof node.type === 'function') {
            try {
              const rendered = node.type(node.props || {});
              findElements(rendered, predicate, acc);
            } catch {}
          }
          if (node.props && node.props.children) {
            findElements(node.props.children, predicate, acc);
          }
        }
        return acc;
      };

      const states: any[] = [];
      const effectsRan: boolean[] = [];
      const internals =
        (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
        (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

      const onCloseMock = vi.fn();
      const renderModal = () => {
        let hookIdx = 0;
        let effectIdx = 0;
        const prevH = internals.H;
        internals.H = {
          useState(initial: any) {
            const idx = hookIdx++;
            if (!(idx in states)) {
              states[idx] = typeof initial === 'function' ? initial() : initial;
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
          const vnode = (GameLaunchConfigModal as any)({
            isOpen: true,
            game: winExeOnMacGame,
            initialPlatformId: 'steam',
            onClose: onCloseMock,
          });
          const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      try {
        renderModal();
        await new Promise((r) => setTimeout(r, 20));
        const rStable = renderModal();

        // Standard CrossOver (single D3DMetal 3.0) shows "D3DMetal: v3.0" badge and hides the dual version switcher
        expect(rStable.html).toContain('data-testid="runner-d3dmetal-version"');
        expect(rStable.html).toContain('D3DMetal: v3.0');
        expect(rStable.html).not.toContain('data-testid="crossover-d3dmetal-version-section"');

        // Switch compatibilityLayer to crossover_preview
        const runnerSelect = findElements(
          rStable.vnode,
          (el) => el.type === 'select' && el.props?.['data-testid'] === 'compat-runner-select'
        )[0];
        expect(runnerSelect).toBeDefined();
        runnerSelect.props.onChange({ target: { value: 'crossover_preview' } });

        const rPreview = renderModal();

        // 1. Verify runner-d3dmetal-version badge shows "D3DMetal: v4.0b3 (Default) / v3.0"
        expect(rPreview.html).toContain('data-testid="runner-d3dmetal-version"');
        expect(rPreview.html).toContain('D3DMetal: v4.0b3 (Default) / v3.0');

        // 2. Verify crossover-d3dmetal-version-section renders with auto, 4, and 3 buttons
        expect(rPreview.html).toContain('data-testid="crossover-d3dmetal-version-section"');
        expect(rPreview.html).toContain('data-testid="d3dmetal-version-auto"');
        expect(rPreview.html).toContain('data-testid="d3dmetal-version-4"');
        expect(rPreview.html).toContain('data-testid="d3dmetal-version-3"');

        // 3. Click d3dmetal-version-3 and Save -> persists crossoverD3DMetalVersion: '3'
        const d3dBtn3 = findElements(
          rPreview.vnode,
          (el) => el.type === 'button' && el.props?.['data-testid'] === 'd3dmetal-version-3'
        )[0];
        expect(d3dBtn3).toBeDefined();
        d3dBtn3.props.onClick();

        const rAfterSelect3 = renderModal();
        const saveBtn = findElements(
          rAfterSelect3.vnode,
          (el) =>
            el.type === 'button' &&
            typeof el.props?.onClick === 'function' &&
            JSON.stringify(el.props.children || '').includes('Save Configuration')
        )[0];
        expect(saveBtn).toBeDefined();
        await saveBtn.props.onClick();

        const savedCfg = launcherService.getLaunchConfig(gameId, 'steam');
        expect(savedCfg?.compatibilityLayer).toBe('crossover_preview');
        expect(savedCfg?.crossoverD3DMetalVersion).toBe('3');
      } finally {
        await launcherService.resetLaunchConfig(gameId);
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
        getUpdatesSpy.mockRestore();
        checkUpdatesSpy.mockRestore();
      }
    });
  });

  // ============================================================================
  // 31. Steam-Style Integrated Window & Menu Bar on Windows/Linux
  // ============================================================================
  describe('31. Steam-Style Integrated Window & Menu Bar on Windows/Linux', () => {
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

    it('1. Windows (electronAPI.platform = "win32") renders Steam-style integrated window bar, File/Edit/View/Window menus, hover switching, performMenuAction IPC dispatches, and minimize/maximize/close controls', async () => {
      const ReactModule = await import('react');
      const React = ReactModule.default || ReactModule;
      const { renderToString } = await import('react-dom/server');
      const { TopNavBar } = await import('../src/components/Navigation/TopNavBar');

      const minimizeWindowMock = vi.fn().mockResolvedValue(undefined);
      const toggleMaximizeWindowMock = vi.fn().mockResolvedValue(true);
      const closeWindowMock = vi.fn().mockResolvedValue(undefined);
      const isWindowMaximizedMock = vi.fn().mockResolvedValue(false);
      const onMaximizedChangedMock = vi.fn().mockReturnValue(() => {});
      const performMenuActionMock = vi.fn().mockResolvedValue(undefined);

      (globalThis as any).window.electronAPI = {
        ...(previousElectronAPI || {}),
        isElectron: true,
        platform: 'win32',
        minimizeWindow: minimizeWindowMock,
        toggleMaximizeWindow: toggleMaximizeWindowMock,
        closeWindow: closeWindowMock,
        isWindowMaximized: isWindowMaximizedMock,
        onMaximizedChanged: onMaximizedChangedMock,
        performMenuAction: performMenuActionMock,
      };

      const findElements = (
        node: any,
        predicate: (el: any) => boolean,
        acc: any[] = []
      ): any[] => {
        if (!node) return acc;
        if (Array.isArray(node)) {
          for (const child of node) findElements(child, predicate, acc);
          return acc;
        }
        if (typeof node === 'object') {
          if (predicate(node)) acc.push(node);
          if (typeof node.type === 'function') {
            try {
              const rendered = node.type(node.props || {});
              findElements(rendered, predicate, acc);
            } catch {}
          }
          if (node.props && node.props.children) {
            findElements(node.props.children, predicate, acc);
          }
        }
        return acc;
      };

      const getTextContent = (node: any): string => {
        if (node === null || node === undefined || typeof node === 'boolean') return '';
        if (typeof node === 'string' || typeof node === 'number') return String(node);
        if (Array.isArray(node)) return node.map(getTextContent).join('');
        if (typeof node === 'object' && node.props) {
          return getTextContent(node.props.children);
        }
        return '';
      };

      const states: any[] = [];
      const effectsRan: boolean[] = [];
      const internals =
        (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
        (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

      const renderTopNav = () => {
        let hookIdx = 0;
        let effectIdx = 0;
        const prevH = internals.H;
        internals.H = {
          useState(initial: any) {
            const idx = hookIdx++;
            if (!(idx in states)) {
              states[idx] = typeof initial === 'function' ? initial() : initial;
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
          const vnode = (TopNavBar as any)({
            selectedPlatform: 'all',
            onSelectPlatform: vi.fn(),
            installedOnly: false,
            onToggleInstalledOnly: vi.fn(),
            totalGamesCount: 42,
            filteredCount: 42,
            isSyncing: false,
            onTriggerSync: vi.fn(),
            onHomeClick: vi.fn(),
            onOpenIntegrations: vi.fn(),
          });
          const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      const r1 = renderTopNav();

      // 1a. Verify steam-integrated-window-bar, 4 menu triggers, and 3 caption buttons render
      expect(r1.html).toContain('data-testid="steam-integrated-window-bar"');
      expect(r1.html).toContain('data-testid="win-menu-file"');
      expect(r1.html).toContain('data-testid="win-menu-edit"');
      expect(r1.html).toContain('data-testid="win-menu-view"');
      expect(r1.html).toContain('data-testid="win-menu-window"');
      expect(r1.html).toContain('data-testid="win-btn-minimize"');
      expect(r1.html).toContain('data-testid="win-btn-maximize"');
      expect(r1.html).toContain('data-testid="win-btn-close"');
      expect(r1.html).toContain('data-mac-traffic-inset="false"');

      // 1b. Click win-menu-view -> opens win-menu-dropdown-view with all 7 View actions
      const viewMenuBtn = findElements(
        r1.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-menu-view'
      )[0];
      expect(viewMenuBtn).toBeDefined();
      viewMenuBtn.props.onClick();

      const rViewOpen = renderTopNav();
      expect(rViewOpen.html).toContain('data-testid="win-menu-dropdown-view"');
      expect(rViewOpen.html).toContain('Reload');
      expect(rViewOpen.html).toContain('Force Reload');
      expect(rViewOpen.html).toContain('Toggle Developer Tools');
      expect(rViewOpen.html).toContain('Actual Size');
      expect(rViewOpen.html).toContain('Zoom In');
      expect(rViewOpen.html).toContain('Zoom Out');
      expect(rViewOpen.html).toContain('Toggle Full Screen');

      // Verify clicking each item in View dropdown calls performMenuAction with exact action ID
      const expectedViewActions: Array<[string, string]> = [
        ['Reload', 'reload'],
        ['Force Reload', 'force-reload'],
        ['Toggle Developer Tools', 'toggle-devtools'],
        ['Actual Size', 'reset-zoom'],
        ['Zoom In', 'zoom-in'],
        ['Zoom Out', 'zoom-out'],
        ['Toggle Full Screen', 'toggle-fullscreen'],
      ];

      for (const [label, actionId] of expectedViewActions) {
        // Ensure View menu is open
        const currentRender = renderTopNav();
        let dropdown = findElements(
          currentRender.vnode,
          (el) => el.props?.['data-testid'] === 'win-menu-dropdown-view'
        )[0];
        if (!dropdown) {
          const btn = findElements(
            currentRender.vnode,
            (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-menu-view'
          )[0];
          btn.props.onClick();
          dropdown = findElements(
            renderTopNav().vnode,
            (el) => el.props?.['data-testid'] === 'win-menu-dropdown-view'
          )[0];
        }
        expect(dropdown).toBeDefined();
        const itemBtn = findElements(
          dropdown,
          (el) =>
            el.type === 'button' &&
            getTextContent(el).startsWith(label) &&
            (label !== 'Reload' || !getTextContent(el).startsWith('Force Reload'))
        )[0];
        expect(itemBtn).toBeDefined();
        itemBtn.props.onClick();
        expect(performMenuActionMock).toHaveBeenLastCalledWith(actionId);
      }

      // 1c. Re-open View menu, then hover over win-menu-file -> switches active dropdown to win-menu-dropdown-file
      const rClosed = renderTopNav();
      const viewTrigger = findElements(
        rClosed.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-menu-view'
      )[0];
      viewTrigger.props.onClick();

      const rViewAgain = renderTopNav();
      expect(rViewAgain.html).toContain('data-testid="win-menu-dropdown-view"');

      const fileTrigger = findElements(
        rViewAgain.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-menu-file'
      )[0];
      expect(fileTrigger).toBeDefined();
      fileTrigger.props.onMouseEnter();

      const rFileHovered = renderTopNav();
      expect(rFileHovered.html).toContain('data-testid="win-menu-dropdown-file"');
      expect(rFileHovered.html).not.toContain('data-testid="win-menu-dropdown-view"');

      // 1d. Click minimize, maximize, and close window caption buttons
      const minBtn = findElements(
        rFileHovered.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-btn-minimize'
      )[0];
      const maxBtn = findElements(
        rFileHovered.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-btn-maximize'
      )[0];
      const closeBtn = findElements(
        rFileHovered.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-btn-close'
      )[0];

      expect(minBtn).toBeDefined();
      expect(maxBtn).toBeDefined();
      expect(closeBtn).toBeDefined();

      minBtn.props.onClick();
      expect(minimizeWindowMock).toHaveBeenCalledTimes(1);

      maxBtn.props.onClick();
      expect(toggleMaximizeWindowMock).toHaveBeenCalledTimes(1);

      closeBtn.props.onClick();
      expect(closeWindowMock).toHaveBeenCalledTimes(1);
    });

    it('2. macOS (electronAPI.platform = "darwin") preserves data-mac-traffic-inset="true" and does NOT render steam-integrated-window-bar or Windows caption buttons', async () => {
      const ReactModule = await import('react');
      const React = ReactModule.default || ReactModule;
      const { renderToString } = await import('react-dom/server');
      const { TopNavBar } = await import('../src/components/Navigation/TopNavBar');

      (globalThis as any).window.electronAPI = {
        ...(previousElectronAPI || {}),
        isElectron: true,
        platform: 'darwin',
      };

      const html = renderToString(
        React.createElement(TopNavBar, {
          selectedPlatform: 'all',
          onSelectPlatform: vi.fn(),
          installedOnly: false,
          onToggleInstalledOnly: vi.fn(),
          totalGamesCount: 42,
          filteredCount: 42,
          isSyncing: false,
          onTriggerSync: vi.fn(),
          onHomeClick: vi.fn(),
          onOpenIntegrations: vi.fn(),
        })
      ).replace(/<!--\s*-->/g, '');

      expect(html).toContain('data-mac-traffic-inset="true"');
      expect(html).toContain('pl-[88px]');
      expect(html).not.toContain('data-testid="steam-integrated-window-bar"');
      expect(html).not.toContain('data-testid="win-btn-minimize"');
      expect(html).not.toContain('data-testid="win-btn-maximize"');
      expect(html).not.toContain('data-testid="win-btn-close"');
    });
  });

  // ============================================================================
  // 32. Holistic Dynamic Relevance & Progressive Disclosure of Launch & Compatibility Settings (Scenarios A–E)
  // ============================================================================
  describe('32. Holistic Dynamic Relevance & Progressive Disclosure of Launch & Compatibility Settings (Scenarios A–E)', () => {
    const mockMacLayers: CompatibilityLayerInfo[] = [
      {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
        availableBottles: ['OneLauncher', 'Steam', 'GOG'],
      },
      {
        id: 'gptk',
        type: 'gptk',
        name: 'Apple Game Porting Toolkit',
        binaryPath:
          '/Users/test/Library/Application Support/heroic/tools/game-porting-toolkit/GPTK-2.0/bin/wine64',
        availableBottles: ['GPTKBottle'],
      },
    ];

    const findElements = (
      node: any,
      predicate: (el: any) => boolean,
      acc: any[] = []
    ): any[] => {
      if (!node) return acc;
      if (Array.isArray(node)) {
        for (const child of node) findElements(child, predicate, acc);
        return acc;
      }
      if (typeof node === 'object') {
        if (predicate(node)) acc.push(node);
        if (typeof node.type === 'function') {
          try {
            const rendered = node.type(node.props || {});
            findElements(rendered, predicate, acc);
          } catch {}
        }
        if (node.props && node.props.children) {
          findElements(node.props.children, predicate, acc);
        }
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

    const createModalRenderer = (game: CanonicalGame, initialPlatformId?: any) => {
      const states: any[] = [];
      const effectsRan: boolean[] = [];
      const internals =
        (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
        (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

      const render = () => {
        let stateIdx = 0;
        let effectIdx = 0;
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
          const vnode = (GameLaunchConfigModal as any)({
            isOpen: true,
            game,
            initialPlatformId,
            onClose: vi.fn(),
          });
          const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      return { render, states };
    };

    it('Scenario A (macOS + Windows .exe game installed — windows_exe_on_mac): restricts availableModes to [auto, compatibility_layer], keeps windows_exe_on_mac when executablePath is omitted after download completion, and promotes launchMethod to compatibility_layer when runner/bottle changes in auto mode', async () => {
      const hostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockMacLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);

      try {
        // 1. Standard windows_exe_on_mac with .exe executablePath
        const winExeGame: CanonicalGame = {
          id: 'steam-1091500-scenA',
          title: 'Cyberpunk 2077',
          sortTitle: 'Cyberpunk 2077',
          steamAppId: 1091500,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '1091500',
              installed: true,
              installPath: '/Users/test/Games/Cyberpunk 2077',
              executablePath: '/Users/test/Games/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe',
              isWindowsBinaryOnMac: true,
            },
          ],
          headerImage: '',
          developers: ['CD PROJEKT RED'],
          publishers: ['CD PROJEKT RED'],
          genres: ['RPG'],
          tags: [],
        };

        const preview1 = launcherService.resolveEffectiveLaunchModePreview(winExeGame, 'steam');
        expect(preview1.detectedBuildType).toBe('windows_exe_on_mac');
        expect(preview1.availableModes).toEqual(['auto', 'compatibility_layer']);
        expect(preview1.availableModes).not.toContain('direct');
        expect(preview1.availableModes).not.toContain('storefront_uri');
        expect(preview1.visibleSections.compatibilityLayer).toBe(true);
        expect(preview1.visibleSections.nativeMacMetalHud).toBe(false);

        // 2. Missing executablePath on GamePlatformOwnership after download completion (via isWindowsBinaryOnMac, Bottle path, or Windows-only metadata)
        const postDownloadEvents: any[] = [];
        const onInstalled = (e: any) => postDownloadEvents.push(e.detail);
        window.addEventListener('antigravity:game-installed', onInstalled);
        try {
          (launcherService as any).handleDownloadUpdated({
            task: {
              taskId: 'dl-scenA-1',
              gameId: 'gog-win-postdl',
              title: 'Post-Download Win Game',
              platformId: 'gog',
              platformGameId: '99887766',
              status: 'completed',
              progressPercent: 100,
              bytesDownloaded: 1024,
              totalBytes: 1024,
              speedBytesPerSec: 0,
              etaSeconds: 0,
              installDir:
                '/Users/test/Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/GOG Games/PostDownloadWinGame',
              // executablePath intentionally omitted on task completion payload
            } satisfies DownloadTaskState,
          });
        } finally {
          window.removeEventListener('antigravity:game-installed', onInstalled);
        }

        expect(postDownloadEvents).toHaveLength(1);
        expect(postDownloadEvents[0].isWindowsBinaryOnMac).toBe(true);

        const postDlGameNoExecPath: CanonicalGame = {
          id: 'gog-win-postdl',
          title: 'Post-Download Win Game',
          sortTitle: 'Post-Download Win Game',
          platforms: [
            {
              platformId: 'gog',
              platformGameId: '99887766',
              installed: true,
              installPath: '/Users/test/Games/FolderWithoutExeSuffix',
              // executablePath missing, but isWindowsBinaryOnMac preserved
              isWindowsBinaryOnMac: true,
            },
          ],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        };
        const previewPostDl = launcherService.resolveEffectiveLaunchModePreview(
          postDlGameNoExecPath,
          'gog'
        );
        expect(previewPostDl.detectedBuildType).toBe('windows_exe_on_mac');
        expect(previewPostDl.detectedBuildType).not.toBe('mac_native_bin');
        expect(previewPostDl.availableModes).toEqual(['auto', 'compatibility_layer']);

        // Also verify Windows-only enrichedMetadata without executablePath or bottle path stays windows_exe_on_mac
        const winMetaOnlyInstalledGame: CanonicalGame = {
          id: 'steam-win-meta-only',
          title: 'Windows Metadata Only Installed Game',
          sortTitle: 'Windows Metadata Only Installed Game',
          steamAppId: 777111,
          enrichedMetadata: {
            platforms: { windows: true, mac: false, linux: false },
          } as any,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '777111',
              installed: true,
              installPath: '/Users/test/Games/WinMetaOnly',
            },
          ],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        };
        const previewMetaOnly = launcherService.resolveEffectiveLaunchModePreview(
          winMetaOnlyInstalledGame,
          'steam'
        );
        expect(previewMetaOnly.detectedBuildType).toBe('windows_exe_on_mac');
        expect(previewMetaOnly.availableModes).toEqual(['auto', 'compatibility_layer']);

        // 3. In GameLaunchConfigModal, manually changing Compatibility Runner or Target Bottle Name while in 'auto' mode promotes launchMethod to 'compatibility_layer'
        const { render } = createModalRenderer(winExeGame, 'steam');
        render();
        await new Promise((r) => setTimeout(r, 10));
        const rAuto = render();

        // Initially in 'auto' mode ("Auto-Detect Runner" badge shown)
        expect(rAuto.html).toContain('Auto-Detect Runner');

        const runnerSelect = findElements(
          rAuto.vnode,
          (el) => el.type === 'select' && el.props?.['data-testid'] === 'compat-runner-select'
        )[0];
        expect(runnerSelect).toBeDefined();
        runnerSelect.props.onChange({ target: { value: 'gptk' } });

        const rAfterRunnerChange = render();
        expect(rAfterRunnerChange.html).toContain('Custom Runner Pinned');

        // Reset back to 'auto' mode, then change Target Bottle Name -> promotes back to 'compatibility_layer'
        const autoModeBtn = findElements(
          rAfterRunnerChange.vnode,
          (el) =>
            el.type === 'button' &&
            getTextContent(el).includes('Auto-Detect Compatibility Pipeline')
        )[0];
        expect(autoModeBtn).toBeDefined();
        autoModeBtn.props.onClick();

        const rBackToAuto = render();
        expect(rBackToAuto.html).toContain('Auto-Detect Runner');

        const bottleSelect = findElements(
          rBackToAuto.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'Target Bottle Name'
        )[0];
        expect(bottleSelect).toBeDefined();
        bottleSelect.props.onChange({ target: { value: 'GPTKBottle' } });

        const rAfterBottleChange = render();
        expect(rAfterBottleChange.html).toContain('Custom Runner Pinned');
      } finally {
        hostSpy.mockRestore();
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
      }
    });

    it('Scenario B (macOS + Native .app or Mach-O binary installed — mac_native_app / mac_native_bin): never misclassifies mac_native_bin as windows_exe_on_mac even when CrossOver has default bottles, excludes compatibility_layer, and shows nativeMacMetalHud', async () => {
      const hostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockMacLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);

      try {
        const nativeBinGame: CanonicalGame = {
          id: 'steam-native-bin-scenB',
          title: 'Factorio Headless Mach-O',
          sortTitle: 'Factorio Headless Mach-O',
          steamAppId: 427520,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '427520',
              installed: true,
              installPath: '/Users/test/Games/NativeBin',
              executablePath: '/Users/test/Games/NativeBin/game_bin',
              isWindowsBinaryOnMac: false,
            },
          ],
          headerImage: '',
          developers: ['Wube Software'],
          publishers: ['Wube Software'],
          genres: ['Strategy'],
          tags: [],
        };

        // Even if draftConfig has a default wineBottleName, mac_native_bin MUST remain mac_native_bin
        const previewBin = launcherService.resolveEffectiveLaunchModePreview(
          nativeBinGame,
          'steam',
          { wineBottleName: 'OneLauncher' }
        );
        expect(previewBin.detectedBuildType).toBe('mac_native_bin');
        expect(previewBin.availableModes).toEqual(['auto', 'direct', 'storefront_uri']);
        expect(previewBin.availableModes).not.toContain('compatibility_layer');
        expect(previewBin.visibleSections).toEqual({
          compatibilityLayer: false,
          crossoverRendering: false,
          nativeMacMetalHud: true,
          executableAndArgs: true,
          environmentAndHooks: true,
        });

        const { render } = createModalRenderer(nativeBinGame, 'steam');
        render();
        await new Promise((r) => setTimeout(r, 10));
        const rModal = render();

        expect(rModal.html).toContain('macOS Native Binary');
        expect(rModal.html).toContain('data-section="native-mac-settings"');
        expect(rModal.html).not.toContain('data-section="compatibility-layer-settings"');
        expect(rModal.html).not.toContain('Custom Compatibility Runner &amp; Bottle');
      } finally {
        hostSpy.mockRestore();
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
      }
    });

    it('Scenario C (Storefront Client Protocol storefront_uri selected on installed game): hides nativeMacMetalHud, executableAndArgs, and environmentAndHooks and renders data-section="storefront-uri-notice"', async () => {
      const hostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockMacLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);

      try {
        const installedNativeAppGame: CanonicalGame = {
          id: 'steam-1145360-scenC',
          title: 'Hades',
          sortTitle: 'Hades',
          steamAppId: 1145360,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '1145360',
              installed: true,
              installPath: '/Users/test/Library/Application Support/Steam/steamapps/common/Hades',
              executablePath:
                '/Users/test/Library/Application Support/Steam/steamapps/common/Hades/Hades.app/Contents/MacOS/Hades',
              isWindowsBinaryOnMac: false,
            },
          ],
          headerImage: '',
          developers: ['Supergiant Games'],
          publishers: ['Supergiant Games'],
          genres: ['Action'],
          tags: [],
        };

        const previewStoreUri = launcherService.resolveEffectiveLaunchModePreview(
          installedNativeAppGame,
          'steam',
          { launchMethod: 'storefront_uri' }
        );
        expect(previewStoreUri.visibleSections).toEqual({
          compatibilityLayer: false,
          crossoverRendering: false,
          nativeMacMetalHud: false,
          executableAndArgs: false,
          environmentAndHooks: false,
        });

        const { render } = createModalRenderer(installedNativeAppGame, 'steam');
        render();
        await new Promise((r) => setTimeout(r, 10));
        const rInitial = render();

        // Initially in 'auto' mode: native-mac-settings, executable-and-args, environment-variables, and shell-hooks are visible
        expect(rInitial.html).toContain('data-section="native-mac-settings"');
        expect(rInitial.html).toContain('data-section="executable-and-args"');
        expect(rInitial.html).toContain('data-section="environment-variables"');
        expect(rInitial.html).toContain('data-section="shell-hooks"');
        expect(rInitial.html).not.toContain('data-section="storefront-uri-notice"');

        // Click 'Storefront Client Protocol' mode button
        const storeUriBtn = findElements(
          rInitial.vnode,
          (el) =>
            el.type === 'button' && getTextContent(el).includes('Storefront Client Protocol')
        )[0];
        expect(storeUriBtn).toBeDefined();
        storeUriBtn.props.onClick();

        const rStoreUri = render();
        expect(rStoreUri.html).toContain('data-section="storefront-uri-notice"');
        expect(rStoreUri.html).not.toContain('data-section="native-mac-settings"');
        expect(rStoreUri.html).not.toContain('data-section="executable-and-args"');
        expect(rStoreUri.html).not.toContain('data-section="environment-variables"');
        expect(rStoreUri.html).not.toContain('data-section="shell-hooks"');
      } finally {
        hostSpy.mockRestore();
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
      }
    });

    it('Scenario D (Uninstalled game not_installed on macOS & Windows — Before Install): enforces pre-install availableModes, GameLaunchConfigModal progressive disclosure, GameInstallModal preinstall-compat-config, and SteamLibraryActionBar gear menu filtering', async () => {
      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockMacLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);

      const uninstalledGame: CanonicalGame = {
        id: 'gog-uninstalled-scenD',
        title: 'Uninstalled RPG',
        sortTitle: 'Uninstalled RPG',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '55443322',
            installed: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: ['RPG'],
        tags: [],
      };

      const macOnlyUninstalledGame: CanonicalGame = {
        id: 'steam-mac-only-scenD',
        title: 'Mac Exclusive Studio Game',
        sortTitle: 'Mac Exclusive Studio Game',
        steamAppId: 888999,
        enrichedMetadata: {
          platforms: { windows: false, mac: true, linux: false },
        } as any,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '888999',
            installed: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      // 1. macOS host ('darwin')
      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      try {
        // 1a. Windows/dual-platform uninstalled game on macOS -> availableModes is ['auto', 'compatibility_layer']
        const previewMacAuto = launcherService.resolveEffectiveLaunchModePreview(
          uninstalledGame,
          'gog',
          { launchMethod: 'auto' }
        );
        expect(previewMacAuto.detectedBuildType).toBe('not_installed');
        expect(previewMacAuto.availableModes).toEqual(['auto', 'compatibility_layer']);
        expect(previewMacAuto.availableModes).not.toContain('direct');
        expect(previewMacAuto.availableModes).not.toContain('storefront_uri');
        expect(previewMacAuto.autoResolvedMethod).toBe('storefront_uri');
        expect(Object.keys(previewMacAuto.modeNotes)).toEqual(
          expect.arrayContaining(['auto', 'direct', 'compatibility_layer', 'storefront_uri'])
        );
        expect(previewMacAuto.visibleSections.compatibilityLayer).toBe(false);
        expect(previewMacAuto.visibleSections.crossoverRendering).toBe(false);

        // 1b. Known macOS-only uninstalled game on macOS -> availableModes is ['auto']
        const previewMacOnly = launcherService.resolveEffectiveLaunchModePreview(
          macOnlyUninstalledGame,
          'steam'
        );
        expect(previewMacOnly.detectedBuildType).toBe('not_installed');
        expect(previewMacOnly.availableModes).toEqual(['auto']);
        expect(previewMacOnly.visibleSections.compatibilityLayer).toBe(false);

        // 1c. Selecting 'compatibility_layer' on uninstalled game reveals compatibilityLayer & crossoverRendering
        const previewMacCompat = launcherService.resolveEffectiveLaunchModePreview(
          uninstalledGame,
          'gog',
          { launchMethod: 'compatibility_layer' }
        );
        expect(previewMacCompat.visibleSections.compatibilityLayer).toBe(true);
        expect(previewMacCompat.visibleSections.crossoverRendering).toBe(true);

        // 1d. GameLaunchConfigModal when !preview.isInstalled:
        // - Default bottle does NOT pollute 'auto' mode into showing compatibility-layer-settings
        // - Shows 'Locate Existing Local Executable' + 'Browse Executable...' while hiding 'Working Directory' and 'Launch Arguments' until customExecutablePath is entered
        // - Labels compatibility_layer as 'Pre-Configure Compatibility Runner & Bottle'
        const { render } = createModalRenderer(uninstalledGame, 'gog');
        render();
        await new Promise((r) => setTimeout(r, 10));
        const rAuto = render();
        expect(rAuto.html).not.toContain('data-section="compatibility-layer-settings"');
        expect(rAuto.html).toContain('Locate Existing Local Executable');
        expect(rAuto.html).toContain('Browse Executable...');
        expect(rAuto.html).not.toContain('Working Directory');
        expect(rAuto.html).not.toContain('Launch Arguments');
        expect(rAuto.html).toContain('Pre-Configure Compatibility Runner &amp; Bottle');

        // Clicking 'Pre-Configure Compatibility Runner & Bottle' reveals compatibility-layer-settings for pre-configuration
        const compatBtn = findElements(
          rAuto.vnode,
          (el) =>
            el.type === 'button' &&
            getTextContent(el).includes('Pre-Configure Compatibility Runner & Bottle')
        )[0];
        expect(compatBtn).toBeDefined();
        compatBtn.props.onClick();

        const rCompat = render();
        expect(rCompat.html).toContain('data-section="compatibility-layer-settings"');

        // Entering a customExecutablePath on uninstalled game reveals Working Directory & Launch Arguments
        const exeInput = findElements(
          rCompat.vnode,
          (el) =>
            el.type === 'input' &&
            typeof el.props?.placeholder === 'string' &&
            el.props.placeholder.includes('Auto-detected from storefront manifest')
        )[0];
        expect(exeInput).toBeDefined();
        exeInput.props.onChange({ target: { value: '/Users/test/Games/UninstalledRPG/game.exe' } });

        const rWithCustomExe = render();
        expect(rWithCustomExe.html).toContain('Working Directory');
        expect(rWithCustomExe.html).toContain('Launch Arguments');

        // 1e. GameInstallModal on macOS: renders preinstall-compat-config when selectedOs === 'windows', hides when selectedOs === 'mac'
        const installInfoSpy = vi
          .spyOn(launcherService, 'getGameInstallInfo')
          .mockResolvedValue({
            success: true,
            platformId: 'gog',
            platformGameId: '55443322',
            defaultInstallDir: '/Users/test/Games/OneLauncher',
            availableInstallDirs: ['/Users/test/Games/OneLauncher'],
            estimatedSizeBytes: 2048,
            availableInstallers: [
              { id: 'win-installer', os: 'windows', title: 'Windows Installer', totalSizeBytes: 2048 },
              { id: 'mac-installer', os: 'mac', title: 'macOS Installer', totalSizeBytes: 2048 },
            ],
          } as any);
        const diskSpy = vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
          freeBytes: 100 * 1024 * 1024 * 1024,
          totalBytes: 500 * 1024 * 1024 * 1024,
          usedBytes: 400 * 1024 * 1024 * 1024,
        } as any);

        try {
          const installStates: any[] = [];
          const installEffects: boolean[] = [];
          const internals =
            (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
            (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
          const renderInstallModal = () => {
            let sIdx = 0;
            let eIdx = 0;
            const prevH = internals.H;
            internals.H = {
              useState(init: any) {
                const idx = sIdx++;
                if (idx >= installStates.length) {
                  installStates.push(typeof init === 'function' ? init() : init);
                }
                const setS = (upd: any) => {
                  installStates[idx] = typeof upd === 'function' ? upd(installStates[idx]) : upd;
                };
                return [installStates[idx], setS];
              },
              useEffect(fn: () => any) {
                const idx = eIdx++;
                if (!installEffects[idx]) {
                  installEffects[idx] = true;
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
                game: uninstalledGame,
                initialPlatformId: 'gog',
                onClose: vi.fn(),
              });
              const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
              return { vnode, html };
            } finally {
              internals.H = prevH;
            }
          };

          renderInstallModal();
          await new Promise((r) => setTimeout(r, 15));
          const rInstallMac = renderInstallModal();
          // Default selects macOS build when available -> preinstall-compat-config is hidden
          expect(rInstallMac.html).not.toContain('data-testid="preinstall-compat-config"');

          // Switch installer dropdown to 'win-installer' -> selectedOs becomes 'windows' -> preinstall-compat-config is shown
          const buildSelect = findElements(
            rInstallMac.vnode,
            (el) => el.type === 'select' && el.props?.['aria-label'] === 'Installer Build'
          )[0];
          expect(buildSelect).toBeDefined();
          buildSelect.props.onChange({ target: { value: 'win-installer' } });

          const rInstallWin = renderInstallModal();
          expect(rInstallWin.html).toContain('data-testid="preinstall-compat-config"');
          expect(rInstallWin.html).toContain('data-testid="preinstall-compat-runner"');
          expect(rInstallWin.html).toContain('data-testid="preinstall-compat-bottle"');
        } finally {
          installInfoSpy.mockRestore();
          diskSpy.mockRestore();
        }

        // 1f. SteamLibraryActionBar Gear Menu (Manage Game) when !isInstalled:
        // Hides 'Browse Local Files' and 'Verify / Repair Game Files', shows 'Install Game...', 'Locate Installed Game...', and 'Mark as Manually Installed'
        const actionStates: any[] = [];
        const actionEffects: boolean[] = [];
        const internals =
          (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
          (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
        const renderActionBar = () => {
          let sIdx = 0;
          let eIdx = 0;
          const prevH = internals.H;
          internals.H = {
            useState(init: any) {
              const idx = sIdx++;
              if (idx >= actionStates.length) {
                actionStates.push(typeof init === 'function' ? init() : init);
              }
              const setS = (upd: any) => {
                actionStates[idx] = typeof upd === 'function' ? upd(actionStates[idx]) : upd;
              };
              return [actionStates[idx], setS];
            },
            useEffect(fn: () => any) {
              const idx = eIdx++;
              if (!actionEffects[idx]) {
                actionEffects[idx] = true;
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
            const vnode = (SteamLibraryActionBar as any)({
              game: uninstalledGame,
            });
            const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
            return { vnode, html };
          } finally {
            internals.H = prevH;
          }
        };

        const rBarClosed = renderActionBar();
        const manageBtn = findElements(
          rBarClosed.vnode,
          (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
        )[0];
        expect(manageBtn).toBeDefined();
        manageBtn.props.onClick();

        const rBarOpen = renderActionBar();
        expect(rBarOpen.html).toContain('Install Game...');
        expect(rBarOpen.html).toContain('Locate Installed Game...');
        expect(rBarOpen.html).toContain('Mark as Manually Installed');
        expect(rBarOpen.html).not.toContain('Browse Local Files');
        expect(rBarOpen.html).not.toContain('Verify / Repair Game Files');
      } finally {
        macHostSpy.mockRestore();
      }

      // 2. Windows host ('win32')
      const winHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      try {
        const previewWin = launcherService.resolveEffectiveLaunchModePreview(
          uninstalledGame,
          'gog'
        );
        expect(previewWin.detectedBuildType).toBe('not_installed');
        expect(previewWin.availableModes).toEqual(['auto']);
        expect(previewWin.availableModes).not.toContain('compatibility_layer');
        expect(previewWin.availableModes).not.toContain('storefront_uri');
        expect(previewWin.visibleSections.compatibilityLayer).toBe(false);
      } finally {
        winHostSpy.mockRestore();
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
      }
    });

    it('Scenario E (custom storefront game): excludes storefront_uri from availableModes across macOS and Windows', () => {
      const customMacAppGame: CanonicalGame = {
        id: 'custom-mac-game-scenE',
        title: 'Custom Indie App',
        sortTitle: 'Custom Indie App',
        platforms: [
          {
            platformId: 'custom',
            platformGameId: 'custom-1',
            installed: true,
            installPath: '/Applications/CustomIndie.app',
            executablePath: '/Applications/CustomIndie.app/Contents/MacOS/CustomIndie',
            isWindowsBinaryOnMac: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const customUninstalledGame: CanonicalGame = {
        id: 'custom-uninstalled-scenE',
        title: 'Unlinked Custom Game',
        sortTitle: 'Unlinked Custom Game',
        platforms: [
          {
            platformId: 'custom',
            platformGameId: 'custom-2',
            installed: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      try {
        const macInstalledPreview = launcherService.resolveEffectiveLaunchModePreview(
          customMacAppGame,
          'custom'
        );
        expect(macInstalledPreview.availableModes).toEqual(['auto', 'direct']);
        expect(macInstalledPreview.availableModes).not.toContain('storefront_uri');

        const macUninstalledPreview = launcherService.resolveEffectiveLaunchModePreview(
          customUninstalledGame,
          'custom'
        );
        expect(macUninstalledPreview.availableModes).toEqual(['auto', 'compatibility_layer']);
        expect(macUninstalledPreview.availableModes).not.toContain('storefront_uri');
      } finally {
        macHostSpy.mockRestore();
      }

      const winHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      try {
        const winInstalledPreview = launcherService.resolveEffectiveLaunchModePreview(
          customMacAppGame,
          'custom'
        );
        expect(winInstalledPreview.availableModes).toEqual(['auto', 'direct']);
        expect(winInstalledPreview.availableModes).not.toContain('storefront_uri');

        const winUninstalledPreview = launcherService.resolveEffectiveLaunchModePreview(
          customUninstalledGame,
          'custom'
        );
        expect(winUninstalledPreview.availableModes).toEqual(['auto']);
        expect(winUninstalledPreview.availableModes).not.toContain('storefront_uri');
      } finally {
        winHostSpy.mockRestore();
      }
    });
  });

  // ============================================================================
  // 33. Per-Store, Per-Game Dual-Build (macOS + Windows) & Single-Build Resolution, UI Presentation, and Install/Launch Execution
  // ============================================================================
  describe('33. Per-Store, Per-Game Dual-Build (macOS + Windows) & Single-Build Resolution, UI Presentation, and Install/Launch Execution', () => {
    const mockMacLayers: CompatibilityLayerInfo[] = [
      {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
        availableBottles: ['OneLauncher', 'Steam', 'GOG'],
      },
      {
        id: 'gptk',
        type: 'gptk',
        name: 'Apple Game Porting Toolkit',
        binaryPath:
          '/Users/test/Library/Application Support/heroic/tools/game-porting-toolkit/GPTK-2.0/bin/wine64',
        availableBottles: ['GPTKBottle'],
      },
    ];

    const findElements = (
      node: any,
      predicate: (el: any) => boolean,
      acc: any[] = []
    ): any[] => {
      if (!node) return acc;
      if (Array.isArray(node)) {
        for (const child of node) findElements(child, predicate, acc);
        return acc;
      }
      if (typeof node === 'object') {
        if (predicate(node)) acc.push(node);
        if (typeof node.type === 'function') {
          try {
            const rendered = node.type(node.props || {});
            findElements(rendered, predicate, acc);
          } catch {}
        }
        if (node.props && node.props.children) {
          findElements(node.props.children, predicate, acc);
        }
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

    it('1. Per-Storefront Isolation & epicPlatformSupport preservation: Epic-only Windows game with Steam Mac metadata (20 Minutes Till Dawn) reports Windows-only and hasDualMacAndWinBuild: false', async () => {
      // 1a. Verify scanAllInstalledGames preserves epicPlatformSupport on returned array
      const prevApi = (window as any).electronAPI;
      const mockEpicSupport = {
        '4656facc740742a39e265b026e13d075': { windows: true, mac: false },
      };
      (window as any).electronAPI = {
        ...prevApi,
        scanAllInstalledGames: vi.fn().mockResolvedValue({
          success: true,
          installedGames: [],
          epicPlatformSupport: mockEpicSupport,
        }),
      };
      try {
        const scanned = await launcherService.scanAllInstalledGames(true);
        expect((scanned as any).epicPlatformSupport).toEqual(mockEpicSupport);
      } finally {
        (window as any).electronAPI = prevApi;
      }

      // 1b. Verify 20 Minutes Till Dawn owned ONLY on Epic with Steam Mac metadata does NOT bleed mac:true
      const epicOnlyTwentyMinutesTillDawn: CanonicalGame = {
        id: 'epic-4656facc740742a39e265b026e13d075',
        title: '20 Minutes Till Dawn',
        sortTitle: '20 Minutes Till Dawn',
        steamAppId: 1966900,
        enrichedMetadata: {
          appId: 1966900,
          name: '20 Minutes Till Dawn',
          shortDescription: 'Shoot down an ever-growing horde of Lovecraftian monsters.',
          headerImage: '',
          developers: ['flanne'],
          publishers: ['Erabit'],
          genres: ['Action'],
          categories: [],
          releaseDate: 'Jun 8, 2023',
          platforms: { windows: true, mac: true, linux: false },
          screenshots: [],
          movies: [],
        },
        platforms: [
          {
            platformId: 'epic',
            platformGameId: '4656facc740742a39e265b026e13d075',
            installed: false,
            platforms: { windows: true, mac: false },
          },
        ],
        headerImage: '',
        developers: ['flanne'],
        publishers: ['Erabit'],
        genres: ['Action'],
        tags: [],
      };

      expect(getNativeOsPlatforms(epicOnlyTwentyMinutesTillDawn)).toEqual(['windows']);
      expect(isNativelyAvailableOnMac(epicOnlyTwentyMinutesTillDawn)).toBe(false);

      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);
      try {
        const preview = launcherService.resolveEffectiveLaunchModePreview(
          epicOnlyTwentyMinutesTillDawn,
          'epic'
        );
        expect(preview.hasDualMacAndWinBuild).toBe(false);
        expect(preview.detectedBuildType).toBe('not_installed');
        expect(preview.detectedBuildLabel).toBe(
          'Not Installed Locally • Windows Build (CrossOver / Wine)'
        );
      } finally {
        macHostSpy.mockRestore();
        getLayersSpy.mockRestore();
      }
    });

    it('2. Multi-Store Duplicate Ownership (Steam has Mac + Windows, GOG has Windows-only): resolves dual build on Steam and Windows-only on GOG across preview and GameInstallModal', async () => {
      const multiStoreGame: CanonicalGame = {
        id: 'steam-777888',
        title: 'Dual Store Tactical RPG',
        sortTitle: 'Dual Store Tactical RPG',
        steamAppId: 777888,
        enrichedMetadata: {
          appId: 777888,
          name: 'Dual Store Tactical RPG',
          shortDescription: 'Tactical RPG with Mac + Win on Steam and Win-only on GOG.',
          headerImage: '',
          developers: ['Tactics Studio'],
          publishers: ['Tactics Studio'],
          genres: ['RPG'],
          categories: [],
          releaseDate: '2024',
          platforms: { windows: true, mac: true, linux: false },
          screenshots: [],
          movies: [],
        },
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '777888',
            installed: false,
            platforms: { windows: true, mac: true },
          },
          {
            platformId: 'gog',
            platformGameId: '9988776655',
            installed: false,
            platforms: { windows: true, mac: false },
          },
        ],
        headerImage: '',
        developers: ['Tactics Studio'],
        publishers: ['Tactics Studio'],
        genres: ['RPG'],
        tags: [],
      };

      expect(getStorefrontNativeOsPlatforms(multiStoreGame, 'steam')).toEqual(['windows', 'mac']);
      expect(getStorefrontNativeOsPlatforms(multiStoreGame, 'gog')).toEqual(['windows']);

      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);
      const diskSpy = vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        freeBytes: 100 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        usedBytes: 400 * 1024 * 1024 * 1024,
      } as any);

      try {
        // 2a. Verify resolveEffectiveLaunchModePreview for Steam vs GOG
        const steamPreview = launcherService.resolveEffectiveLaunchModePreview(
          multiStoreGame,
          'steam'
        );
        expect(steamPreview.hasDualMacAndWinBuild).toBe(true);
        expect(steamPreview.detectedBuildLabel).toBe(
          'Not Installed Locally • Native macOS (Recommended) & Windows Builds Available'
        );
        expect(steamPreview.modeNotes.auto.badge).toBe('Recommended • Native macOS');
        expect(steamPreview.modeNotes.compatibility_layer.badge).toBe('Windows Translation');

        const gogPreview = launcherService.resolveEffectiveLaunchModePreview(multiStoreGame, 'gog');
        expect(gogPreview.hasDualMacAndWinBuild).toBe(false);
        expect(gogPreview.detectedBuildLabel).toBe(
          'Not Installed Locally • Windows Build (CrossOver / Wine)'
        );

        // 2b. Verify GameInstallModal on Steam renders both install-option-mac-native and install-option-win-compat
        // while GameInstallModal on GOG shows only the Windows CrossOver/Wine build
        const createInstallModalHarness = (initialPlat: 'steam' | 'gog') => {
          const states: any[] = [];
          const effects: boolean[] = [];
          const internals =
            (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
            (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
          const render = () => {
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
                game: multiStoreGame,
                initialPlatformId: initialPlat,
                onClose: vi.fn(),
              });
              const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
              return { vnode, html };
            } finally {
              internals.H = prevH;
            }
          };
          return { render };
        };

        const steamModal = createInstallModalHarness('steam');
        steamModal.render();
        await new Promise((r) => setTimeout(r, 15));
        const rSteam = steamModal.render();
        expect(rSteam.html).toContain('data-testid="install-option-mac-native"');
        expect(rSteam.html).toContain('★ Recommended • Native macOS');
        expect(rSteam.html).toContain('data-testid="install-option-win-compat"');
        expect(rSteam.html).toContain('Windows Build (CrossOver / Wine)');

        const gogModal = createInstallModalHarness('gog');
        gogModal.render();
        await new Promise((r) => setTimeout(r, 15));
        const rGog = gogModal.render();
        expect(rGog.html).not.toContain('data-testid="install-option-mac-native"');
        expect(rGog.html).not.toContain('data-testid="install-option-win-compat"');
        expect(rGog.html).toContain('AUTO-DETECTED • WINDOWS BUILD (CROSSOVER / WINE)');
      } finally {
        macHostSpy.mockRestore();
        getLayersSpy.mockRestore();
        diskSpy.mockRestore();
      }
    });

    it('3. Selected Build Is Actually Installed & Launched: GameInstallModal saves/resets launchConfig & passes os/runner/bottle, findPrimaryExecutable respects preferWindowsExecutable, and launchGame never runs Wine on native Mac binaries', async () => {
      const dualBuildGame: CanonicalGame = {
        id: 'gog-dual-build-exec',
        title: 'Dual Build SciFi',
        sortTitle: 'Dual Build SciFi',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1122334455',
            installed: false,
            platforms: { windows: true, mac: true },
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);
      const diskSpy = vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        freeBytes: 100 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        usedBytes: 400 * 1024 * 1024 * 1024,
      } as any);
      const startInstallSpy = vi
        .spyOn(launcherService, 'startInstall')
        .mockResolvedValue({ success: true } as any);

      try {
        const states: any[] = [];
        const effects: boolean[] = [];
        const internals =
          (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
          (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
        const renderInstallModal = () => {
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
              game: dualBuildGame,
              initialPlatformId: 'gog',
              onClose: vi.fn(),
            });
            const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
            return { vnode, html };
          } finally {
            internals.H = prevH;
          }
        };

        renderInstallModal();
        await new Promise((r) => setTimeout(r, 15));
        const rInitial = renderInstallModal();

        // 3a. Click Windows Compatibility build card ('install-option-win-compat'), select runner & bottle, and click Start Download & Install
        const winCardBtn = findElements(
          rInitial.vnode,
          (el) => el.type === 'button' && el.props?.['data-testid'] === 'install-option-win-compat'
        )[0];
        expect(winCardBtn).toBeDefined();
        winCardBtn.props.onClick();

        const rWinSelected = renderInstallModal();
        const bottleSelect = findElements(
          rWinSelected.vnode,
          (el) => el.type === 'select' && el.props?.['data-testid'] === 'preinstall-compat-bottle'
        )[0];
        expect(bottleSelect).toBeDefined();
        bottleSelect.props.onChange({ target: { value: 'GOG' } });

        const rReadyWin = renderInstallModal();
        const startBtnWin = findElements(
          rReadyWin.vnode,
          (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
        )[0];
        expect(startBtnWin).toBeDefined();
        await startBtnWin.props.onClick();

        const savedWinCfg = launcherService.getLaunchConfig(dualBuildGame.id, 'gog');
        expect(savedWinCfg?.launchMethod).toBe('compatibility_layer');
        expect(savedWinCfg?.compatibilityLayer).toBe('crossover');
        expect(savedWinCfg?.wineBottleName).toBe('GOG');
        expect(startInstallSpy).toHaveBeenLastCalledWith(
          expect.objectContaining({
            gameId: dualBuildGame.id,
            platformId: 'gog',
            os: 'windows',
            compatibilityLayer: 'crossover',
            wineBottleName: 'GOG',
          })
        );

        // 3b. Now click Recommended Native macOS build card ('install-option-mac-native') and click Start Download & Install
        // Verify it invokes startInstall with os: 'mac' and resets launchMethod from 'compatibility_layer' to 'auto'
        const rAfterWin = renderInstallModal();
        const macCardBtn = findElements(
          rAfterWin.vnode,
          (el) => el.type === 'button' && el.props?.['data-testid'] === 'install-option-mac-native'
        )[0];
        expect(macCardBtn).toBeDefined();
        macCardBtn.props.onClick();

        const rReadyMac = renderInstallModal();
        const startBtnMac = findElements(
          rReadyMac.vnode,
          (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
        )[0];
        expect(startBtnMac).toBeDefined();
        await startBtnMac.props.onClick();

        const savedMacCfg = launcherService.getLaunchConfig(dualBuildGame.id, 'gog');
        expect(savedMacCfg?.launchMethod).toBe('auto');
        expect(savedMacCfg?.compatibilityLayer).toBeUndefined();
        expect(startInstallSpy).toHaveBeenLastCalledWith(
          expect.objectContaining({
            gameId: dualBuildGame.id,
            platformId: 'gog',
            os: 'mac',
          })
        );
      } finally {
        macHostSpy.mockRestore();
        getLayersSpy.mockRestore();
        diskSpy.mockRestore();
        startInstallSpy.mockRestore();
      }

      // 3c. Verify launcherEngine.findPrimaryExecutable respects preferWindowsExecutable when both .app and .exe exist,
      // and launcherEngine.launchGame never invokes Wine/CrossOver on a native .app / Mach-O binary (isMacNativeExecutable)
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-dual-build-'));
      try {
        const appBundleMacOsDir = path.join(
          tmpDir,
          'DualBuildGame.app',
          'Contents',
          'MacOS'
        );
        fs.mkdirSync(appBundleMacOsDir, { recursive: true });
        const macNativeBinPath = path.join(appBundleMacOsDir, 'DualBuildGame');
        fs.writeFileSync(macNativeBinPath, '#!/bin/sh\nsleep 2\n', { mode: 0o755 });

        const winExePath = path.join(tmpDir, 'DualBuildGame.exe');
        fs.writeFileSync(winExePath, 'MZ-fake-windows-pe-binary-payload');

        // Default on darwin (preferWindowsExecutable: false) selects native .app
        const defaultDiscovered = launcherEngine.findPrimaryExecutable(tmpDir, {
          platform: 'darwin',
          preferWindowsExecutable: false,
        });
        expect(defaultDiscovered.executablePath).toBe(macNativeBinPath);
        expect(defaultDiscovered.isWindowsBinaryOnMac).toBe(false);

        // preferWindowsExecutable: true on darwin selects .exe and sets isWindowsBinaryOnMac: true
        const winPreferredDiscovered = launcherEngine.findPrimaryExecutable(tmpDir, {
          platform: 'darwin',
          preferWindowsExecutable: true,
        });
        expect(winPreferredDiscovered.executablePath).toBe(winExePath);
        expect(winPreferredDiscovered.isWindowsBinaryOnMac).toBe(true);

        // Verify launchGame never invokes Wine/CrossOver on a native .app or Mach-O binary even if compatibilityLayer is passed
        const launchRes = await launcherEngine.launchGame(
          {
            gameId: 'mac-native-guard-test',
            title: 'DualBuildGame',
            platformId: 'gog',
            platformGameId: '1122334455',
            installPath: path.join(tmpDir, 'DualBuildGame.app'),
            executablePath: macNativeBinPath,
            isWindowsBinaryOnMac: false,
            launchConfig: {
              gameId: 'mac-native-guard-test',
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
            },
          },
          {
            platform: 'darwin',
            userDataDir: tmpDir,
            skipStartupWait: true,
          }
        );

        expect(launchRes.success).toBe(true);
        expect(launchRes.session?.launchMethod).toBe('direct');
        expect(launchRes.session?.executablePath).toBe(macNativeBinPath);

        await launcherEngine.stopGame('mac-native-guard-test');
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  // =========================================================================
  // 34. REAL-WORLD WINDOWS X64 FEEDBACK FIXES: EPIC FIRST-PARTY REGISTRATION,
  //     STEAM MANAGED INSTALL LOCATION, & STEAM PREALLOCATION PROGRESS GUARD
  // =========================================================================
  describe('34. Real-World Windows x64 Feedback Fixes: Epic First-Party Registration, Steam Managed Install Location & Steam Preallocation Progress Guard', () => {
    it('Issue 1: syncEpicFirstPartyLauncher on Windows x64 extracts nested asset_infos.Windows CatalogItemId/CatalogNamespace, self-heals incomplete .item manifests, writes .egstore/<guid>.mancpn & <guid>.manifest, and updates LauncherInstalled.dat', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-win64-epic-sync-'));
      const tempUserData = path.join(tempDir, 'userData');
      const eglManifestsDir = path.join(tempDir, 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
      const eglLauncherInstalledDat = path.join(
        tempDir,
        'ProgramData',
        'Epic',
        'UnrealEngineLauncher',
        'LauncherInstalled.dat'
      );

      try {
        const appName = 'b3c4d5e6f7a8901234567890abcdef12';
        const catalogItemId = 'cat_item_99887766554433221100ff';
        const catalogNamespace = 'ns_epic_win64_realworld_01';
        const guid = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
        const installPath = path.join(tempDir, 'Games', 'CyberActionWin64');
        const binDir = path.join(installPath, 'Binaries', 'Win64');
        fs.mkdirSync(binDir, { recursive: true });

        const exePath = path.join(binDir, 'CyberAction-Win64-Shipping.exe');
        fs.writeFileSync(exePath, 'MZ-windows-x64-shipping-executable');

        const legBaseDir = path.join(tempUserData, 'legendaryConfig', 'legendary');
        const legMetaDir = path.join(legBaseDir, 'metadata');
        const legManifestsDir = path.join(legBaseDir, 'manifests');
        fs.mkdirSync(legMetaDir, { recursive: true });
        fs.mkdirSync(legManifestsDir, { recursive: true });

        // 1. Write Legendary installed.json with Windows backslash relative executable
        const installedJsonPath = path.join(legBaseDir, 'installed.json');
        fs.writeFileSync(
          installedJsonPath,
          JSON.stringify(
            {
              [appName]: {
                app_name: appName,
                title: 'Cyber Action Win64',
                install_path: installPath,
                executable: '.\\Binaries\\Win64\\CyberAction-Win64-Shipping.exe',
                version: '2.4.1-win64',
                install_size: 4294967296,
                platform: 'Windows',
              },
            },
            null,
            2
          ),
          'utf8'
        );

        // 2. Write metadata/<appName>.json with nested asset_infos.Windows.catalog_item_id & namespace
        //    and metadata.customAttributes.FolderName.value
        fs.writeFileSync(
          path.join(legMetaDir, `${appName}.json`),
          JSON.stringify(
            {
              app_name: appName,
              app_title: 'Cyber Action Win64',
              asset_infos: {
                Windows: {
                  app_name: appName,
                  asset_id: appName,
                  build_version: '2.4.1-win64',
                  catalog_item_id: catalogItemId,
                  namespace: catalogNamespace,
                },
              },
              metadata: {
                customAttributes: {
                  FolderName: {
                    type: 'STRING',
                    value: 'CyberActionCustomFolder',
                  },
                },
              },
            },
            null,
            2
          ),
          'utf8'
        );

        // 3. Write binary manifest in manifests/<appName>_win.manifest
        const sourceManifestBytes = Buffer.from('EPIC-BINARY-MANIFEST-WIN64-PAYLOAD-9876543210', 'utf8');
        const sourceManifestFile = path.join(legManifestsDir, `${appName}_win.manifest`);
        fs.writeFileSync(sourceManifestFile, sourceManifestBytes);

        // 4. Place an existing incomplete .item manifest in eglManifestsDir with empty CatalogItemId & CatalogNamespace
        //    and missing .egstore/<guid>.mancpn to verify self-healing
        fs.mkdirSync(eglManifestsDir, { recursive: true });
        fs.writeFileSync(
          path.join(eglManifestsDir, `${guid}.item`),
          JSON.stringify(
            {
              FormatVersion: 0,
              bIsIncompleteInstall: false,
              AppName: appName,
              DisplayName: 'Cyber Action Win64',
              InstallationGuid: guid,
              InstallLocation: installPath,
              CatalogItemId: '',
              CatalogNamespace: '',
              LaunchExecutable: '.\\Binaries\\Win64\\CyberAction-Win64-Shipping.exe',
            },
            null,
            2
          ),
          'utf8'
        );

        //Also place a stale .item inside .egstore to verify cleanup
        const egstoreDir = path.join(installPath, '.egstore');
        fs.mkdirSync(egstoreDir, { recursive: true });
        fs.writeFileSync(path.join(egstoreDir, `${guid}.item`), '{}', 'utf8');

        // 5. Run syncEpicFirstPartyLauncher
        const syncRes = launcherEngine.syncEpicFirstPartyLauncher({
          platform: 'win32',
          homedir: tempDir,
          userDataDir: tempUserData,
          eglManifestsDir,
          eglLauncherInstalledDat,
        });

        expect(syncRes.synced).toBe(1);

        // Verify self-healed <guid>.item in eglManifestsDir
        const healedItemPath = path.join(eglManifestsDir, `${guid}.item`);
        expect(fs.existsSync(healedItemPath)).toBe(true);
        const healedItem = JSON.parse(fs.readFileSync(healedItemPath, 'utf8'));
        expect(healedItem.CatalogItemId).toBe(catalogItemId);
        expect(healedItem.CatalogNamespace).toBe(catalogNamespace);
        expect(healedItem.MandatoryAppFolderName).toBe('CyberActionCustomFolder');
        expect(healedItem.FullAppName).toBe(appName);
        expect(healedItem.MainGameAppName).toBe(appName);
        expect(healedItem.LaunchExecutable).toBe('Binaries/Win64/CyberAction-Win64-Shipping.exe');
        expect(healedItem.bIsIncompleteInstall).toBe(false);

        // Verify stale .item inside .egstore was removed
        expect(fs.existsSync(path.join(egstoreDir, `${guid}.item`))).toBe(false);

        // Verify <installPath>/.egstore/<guid>.mancpn exists and has required fields
        const mancpnPath = path.join(egstoreDir, `${guid}.mancpn`);
        expect(fs.existsSync(mancpnPath)).toBe(true);
        const mancpn = JSON.parse(fs.readFileSync(mancpnPath, 'utf8'));
        expect(mancpn).toEqual({
          FormatVersion: 0,
          AppName: appName,
          CatalogItemId: catalogItemId,
          CatalogNamespace: catalogNamespace,
        });

        // Verify <installPath>/.egstore/<guid>.manifest exists and matches binary manifest from manifests/
        const copiedManifestPath = path.join(egstoreDir, `${guid}.manifest`);
        expect(fs.existsSync(copiedManifestPath)).toBe(true);
        expect(fs.readFileSync(copiedManifestPath).equals(sourceManifestBytes)).toBe(true);

        // Verify LauncherInstalled.dat has the entry with NamespaceId: catalogNamespace and ItemId: catalogItemId
        expect(fs.existsSync(eglLauncherInstalledDat)).toBe(true);
        const launcherInstalled = JSON.parse(fs.readFileSync(eglLauncherInstalledDat, 'utf8'));
        expect(Array.isArray(launcherInstalled.InstallationList)).toBe(true);
        const entry = launcherInstalled.InstallationList.find((e: any) => e.AppName === appName);
        expect(entry).toBeDefined();
        expect(entry.InstallLocation).toBe(installPath);
        expect(entry.NamespaceId).toBe(catalogNamespace);
        expect(entry.ItemId).toBe(catalogItemId);
        expect(entry.ArtifactId).toBe(appName);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Issue 2: getGameInstallInfo discovers Steam steamapps/common directories and GameInstallModal renders read-only Managed by Steam Client notice (with multi-library selector) for Steam while keeping editable directory input & Browse button for GOG/Epic', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-steam-install-loc-'));
      try {
        const primarySteamRoot = path.join(tempDir, 'SteamPrimary');
        const primarySteamapps = path.join(primarySteamRoot, 'steamapps');
        const primaryCommon = path.join(primarySteamapps, 'common');
        fs.mkdirSync(primaryCommon, { recursive: true });

        const secondarySteamRoot = path.join(tempDir, 'SteamSecondaryDrive');
        const secondarySteamapps = path.join(secondarySteamRoot, 'steamapps');
        const secondaryCommon = path.join(secondarySteamapps, 'common');
        fs.mkdirSync(secondaryCommon, { recursive: true });

        // Write libraryfolders.vdf in primarySteamapps pointing to both libraries
        const vdfContent = `"libraryfolders"
{
  "0"
  {
    "path" "${primarySteamRoot.replace(/\\/g, '\\\\')}"
  }
  "1"
  {
    "path" "${secondarySteamRoot.replace(/\\/g, '\\\\')}"
  }
}`;
        fs.writeFileSync(path.join(primarySteamapps, 'libraryfolders.vdf'), vdfContent, 'utf8');

        // 2a. Verify launcherEngine.getGameInstallInfo for platformId: 'steam' discovers steamapps/common
        const steamInstallInfo = await launcherEngine.getGameInstallInfo(
          {
            platformId: 'steam',
            platformGameId: '1091500',
            steamAppId: 1091500,
            title: 'Cyberpunk 2077',
          },
          {
            platform: 'win32',
            homedir: tempDir,
            userDataDir: tempDir,
            customRoots: [primarySteamRoot],
            skipNetwork: true,
          }
        );

        expect(steamInstallInfo.defaultInstallDir).toBe(primaryCommon);
        expect(steamInstallInfo.availableInstallDirs).toContain(primaryCommon);
        expect(steamInstallInfo.availableInstallDirs).toContain(secondaryCommon);

        // 2b. Render GameInstallModal for a Steam game (selectedPlatformId === 'steam')
        const testGame: Game = {
          id: 'multi-store-loc-test',
          title: 'Cyberpunk 2077',
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '1091500',
              installed: false,
              storePlatforms: { windows: true, mac: false, linux: false },
            } as any,
            {
              platformId: 'gog',
              platformGameId: '1423049311',
              installed: false,
              storePlatforms: { windows: true, mac: false, linux: false },
            } as any,
          ],
          status: 'backlog',
          playtimeMinutes: 0,
           addedAt: new Date().toISOString(),
          genres: [],
          tags: [],
        };

        const winHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
        const getInstallInfoSpy = vi
          .spyOn(launcherService, 'getGameInstallInfo')
          .mockImplementation(async (_game, platId) => {
            if (platId === 'steam') {
              return {
                platformId: 'steam',
                platformGameId: '1091500',
                hostPlatform: 'win32',
                estimatedSizeBytes: 60 * 1024 * 1024 * 1024,
                defaultInstallDir: primaryCommon,
                availableInstallDirs: [primaryCommon, secondaryCommon],
                availableInstallers: [
                  {
                    id: 'steam-win-native',
                    name: 'Cyberpunk 2077 (Steam Client — Windows Native)',
                    os: 'windows',
                    totalSizeBytes: 60 * 1024 * 1024 * 1024,
                  },
                ],
                canDirectDownload: false,
                requiresStoreClientFallback: true,
                diskSpace: {
                  freeBytes: 250 * 1024 * 1024 * 1024,
                  totalBytes: 500 * 1024 * 1024 * 1024,
                  usedBytes: 250 * 1024 * 1024 * 1024,
                },
              } as any;
            }
            return {
              platformId: 'gog',
              platformGameId: '1423049311',
              hostPlatform: 'win32',
              estimatedSizeBytes: 60 * 1024 * 1024 * 1024,
              defaultInstallDir: 'C:\\Games\\OneLauncher',
              availableInstallDirs: ['C:\\Games\\OneLauncher', 'D:\\GOG Games'],
              availableInstallers: [
                {
                  id: 'gog-win-native',
                  name: 'Cyberpunk 2077 — Windows Native Build',
                  os: 'windows',
                  totalSizeBytes: 60 * 1024 * 1024 * 1024,
                },
              ],
              canDirectDownload: true,
              requiresStoreClientFallback: false,
              diskSpace: {
                freeBytes: 250 * 1024 * 1024 * 1024,
                totalBytes: 500 * 1024 * 1024 * 1024,
                usedBytes: 250 * 1024 * 1024 * 1024,
              },
            } as any;
          });

        try {
          const renderModalForPlatform = async (platformId: 'steam' | 'gog') => {
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
                  game: testGame,
                  initialPlatformId: platformId,
                  onClose: vi.fn(),
                });
                const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
                return { vnode, html };
              } finally {
                internals.H = prevH;
              }
            };
            doRender();
            await new Promise((r) => setTimeout(r, 15));
            return doRender();
          };

          const getTextContent = (node: any): string => {
            if (node == null || typeof node === 'boolean') return '';
            if (typeof node === 'string' || typeof node === 'number') return String(node);
            if (Array.isArray(node)) return node.map(getTextContent).join('');
            if (node.props?.children) return getTextContent(node.props.children);
            return '';
          };
          const findElements = (node: any, predicate: (el: any) => boolean, acc: any[] = []): any[] => {
            if (!node || typeof node !== 'object') return acc;
            if (Array.isArray(node)) {
              node.forEach((c) => findElements(c, predicate, acc));
              return acc;
            }
            if (predicate(node)) acc.push(node);
            if (node.props?.children) findElements(node.props.children, predicate, acc);
            return acc;
          };

          // Steam modal assertions
          const steamRendered = await renderModalForPlatform('steam');
          expect(steamRendered.html).toContain('data-testid="steam-managed-install-location"');
          expect(steamRendered.html).toContain('Managed by Steam Client');
          expect(steamRendered.html).toContain('data-testid="steam-library-drive-select"');

          const steamTextInputs = findElements(
            steamRendered.vnode,
            (el) => el.type === 'input' && el.props?.type === 'text'
          );
          expect(steamTextInputs).toHaveLength(0);
          const steamBrowseBtns = findElements(
            steamRendered.vnode,
            (el) => el.type === 'button' && getTextContent(el).includes('Browse...')
          );
          expect(steamBrowseBtns).toHaveLength(0);

          // GOG modal assertions
          const gogRendered = await renderModalForPlatform('gog');
          expect(gogRendered.html).not.toContain('data-testid="steam-managed-install-location"');
          expect(gogRendered.html).toContain('Installation Directory');

          const gogTextInputs = findElements(
            gogRendered.vnode,
            (el) => el.type === 'input' && el.props?.type === 'text'
          );
          expect(gogTextInputs.length).toBeGreaterThanOrEqual(1);
          const gogBrowseBtns = findElements(
            gogRendered.vnode,
            (el) => el.type === 'button' && getTextContent(el).includes('Browse...')
          );
          expect(gogBrowseBtns.length).toBeGreaterThanOrEqual(1);
        } finally {
          winHostSpy.mockRestore();
          getInstallInfoSpy.mockRestore();
        }
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Issue 3: parseSteamContentLogForApp resets stale download counters on update started / Uninstalled, and startSteamInstallMonitor ignores 100% pre-allocated downloading/<appId> files while advancing 0% -> 25% -> 60% -> 100%', async () => {
      // 3a. Verify parseSteamContentLogForApp resets historical download/stage counters when update started or Uninstalled appears
      const logWithHistoryAndReset = [
        '[2026-10-21 10:00:01] AppID 1091500 update started : download 0/50000000',
        '[2026-10-21 10:05:10] AppID 1091500 download 50000000/50000000',
        '[2026-10-21 10:05:12] AppID 1091500 stage 50000000/50000000',
        '[2026-10-21 10:05:15] AppID 1091500 state changed : Fully Installed,',
        '[2026-10-21 10:15:00] AppID 1091500 state changed : Uninstalled,',
        '[2026-10-21 10:20:00] AppID 1091500 update started :',
        '[2026-10-21 10:20:01] AppID 1091500 App update changed : Running Update, Preallocating,',
      ].join('\n');

      const parsedResetLog = launcherEngine.parseSteamContentLogForApp(
        logWithHistoryAndReset,
        '1091500'
      );
      expect(parsedResetLog.bytesDownloaded).toBe(0);
      expect(parsedResetLog.bytesToDownload).toBe(0);
      expect(parsedResetLog.bytesStaged).toBe(0);
      expect(parsedResetLog.bytesToStage).toBe(0);
      expect(parsedResetLog.fullyInstalled).toBe(false);
      expect(parsedResetLog.updateStarted).toBe(true);
      expect(parsedResetLog.isRunning).toBe(true);

      // 3b. Verify startSteamInstallMonitor never jumps to 99% when steamapps/downloading/<appId> has 100% preallocated sparse files
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-steam-prealloc-'));
      const tempUserData = path.join(tempDir, 'userData');
      const steamRoot = path.join(tempDir, 'Steam');
      const steamappsDir = path.join(steamRoot, 'steamapps');
      const appId = '1091500';
      const downloadingAppDir = path.join(steamappsDir, 'downloading', appId);
      const commonAppDir = path.join(steamappsDir, 'common', 'PreallocGame');
      fs.mkdirSync(downloadingAppDir, { recursive: true });
      fs.mkdirSync(tempUserData, { recursive: true });

      const totalGameBytes = 200000;
      // Write a pre-allocated file equal to 100% of totalGameBytes inside steamapps/downloading/<appId>
      fs.writeFileSync(
        path.join(downloadingAppDir, 'preallocated_depot.bin'),
        Buffer.alloc(totalGameBytes, 0)
      );

      const writeAcf = (bytesDownloaded: number, stateFlags: string) => {
        const acfContent = `"AppState"
{
	"appid"		"${appId}"
	"Universe"		"1"
	"name"		"PreallocGame"
	"StateFlags"		"${stateFlags}"
	"installdir"		"PreallocGame"
	"SizeOnDisk"		"${totalGameBytes}"
	"BytesToDownload"		"${totalGameBytes}"
	"BytesDownloaded"		"${bytesDownloaded}"
	"BytesToStage"		"${totalGameBytes}"
	"BytesStaged"		"${bytesDownloaded}"
}`;
        fs.writeFileSync(path.join(steamappsDir, `appmanifest_${appId}.acf`), acfContent, 'utf8');
      };

      // Initial state: Preallocating / starting download with BytesDownloaded = 0, StateFlags = 1026
      writeAcf(0, '1026');

      const monitorOptions = {
        platform: 'win32',
        homedir: tempDir,
        userDataDir: tempUserData,
        customRoots: [steamRoot],
        steamPollIntervalMs: 20,
      };

      try {
        const installRes = await launcherEngine.installGame(
          {
            gameId: 'steam-prealloc-test',
            title: 'PreallocGame',
            platformId: 'steam',
            platformGameId: appId,
            steamAppId: Number(appId),
            totalBytes: totalGameBytes,
            manualControl: true,
          },
          monitorOptions
        );
        expect(installRes.success).toBe(true);
        const taskId = installRes.task.taskId;

        launcherEngine.startSteamInstallMonitor(taskId, appId, monitorOptions);

        // Wait for monitor ticks with BytesDownloaded = 0 while downloading/<appId> has 100% preallocated size
        await new Promise((r) => setTimeout(r, 60));
        let currentTask = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
        expect(currentTask).toBeDefined();
        expect(currentTask.progressPercent).toBe(0);
        expect(currentTask.bytesDownloaded).toBe(0);
        expect(currentTask.status).toBe('downloading');

        // Advance ACF to 25% (50,000 / 200,000)
        writeAcf(50000, '1026');
        await new Promise((r) => setTimeout(r, 60));
        currentTask = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
        expect(currentTask.progressPercent).toBe(25);
        expect(currentTask.bytesDownloaded).toBe(50000);

        // Advance ACF to 60% (120,000 / 200,000)
        writeAcf(120000, '1026');
        await new Promise((r) => setTimeout(r, 60));
        currentTask = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
        expect(currentTask.progressPercent).toBe(60);
        expect(currentTask.bytesDownloaded).toBe(120000);

        // Complete installation: create common/PreallocGame with .exe and set BytesDownloaded = 200,000, StateFlags = 4
        fs.mkdirSync(commonAppDir, { recursive: true });
        fs.writeFileSync(path.join(commonAppDir, 'PreallocGame.exe'), 'MZ-win64-pe');
        writeAcf(totalGameBytes, '4');
        await new Promise((r) => setTimeout(r, 60));

        currentTask = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
        expect(currentTask.status).toBe('completed');
        expect(currentTask.progressPercent).toBe(100);
        expect(currentTask.finalInstallPath).toBe(commonAppDir);
      } finally {
        launcherEngine.clearDownloadQueue();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('detects older libMoltenVK.dylib _GLOBAL__sub_I_mvk_datatypes.mm deadlock symbol, keeps MTL_HUD_ENABLED=1 while injecting libone_metal_preload.dylib, cleans up when metalHud is false, and resolves adjacent/parent wineserver binaries', () => {
      const mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-mvk-hud-test-'));
      try {
        // 1. Wine distribution WITH _GLOBAL__sub_I_mvk_datatypes.mm in lib/libMoltenVK.dylib
        const legacyWineRoot = path.join(mockRoot, 'wine-legacy');
        const legacyWineBin = path.join(legacyWineRoot, 'bin', 'wine64');
        const legacyWineserver = path.join(legacyWineRoot, 'bin', 'wineserver');
        const legacyMvkDylib = path.join(legacyWineRoot, 'lib', 'libMoltenVK.dylib');
        writeTempFile(legacyWineBin, '#!/bin/sh\nexit 0\n', 0o755);
        writeTempFile(legacyWineserver, '#!/bin/sh\nexit 0\n', 0o755);
        writeTempFile(
          legacyMvkDylib,
          'FAKE_MACHO_HEADER\0__TEXT\0_GLOBAL__sub_I_mvk_datatypes.mm\0MTLRegisterDevices\0'
        );

        // 2. Wine distribution WITHOUT _GLOBAL__sub_I_mvk_datatypes.mm in lib/external/libMoltenVK.dylib
        const modernWineRoot = path.join(mockRoot, 'wine-modern');
        const modernWineBin = path.join(modernWineRoot, 'lib', 'wine', 'x86_64-unix', 'wine');
        const modernWineserver = path.join(modernWineRoot, 'lib', 'wine', 'bin', 'wineserver64');
        const modernMvkDylib = path.join(
          modernWineRoot,
          'lib',
          'wine',
          'lib',
          'external',
          'libMoltenVK.dylib'
        );
        writeTempFile(modernWineBin, '#!/bin/sh\nexit 0\n', 0o755);
        writeTempFile(modernWineserver, '#!/bin/sh\nexit 0\n', 0o755);
        writeTempFile(modernMvkDylib, 'FAKE_MACHO_HEADER\0__TEXT\0mvkCreateInstance\0');

        launcherEngine.invalidateScanCaches();

        // Verify resolveWineLayerMoltenVkPath & ensureWineMetalPreloadDylib
        expect(launcherEngine.resolveWineLayerMoltenVkPath(legacyWineBin)).toBe(legacyMvkDylib);
        expect(launcherEngine.resolveWineLayerMoltenVkPath(modernWineBin)).toBe(modernMvkDylib);
        const preloadDylib = launcherEngine.ensureWineMetalPreloadDylib({ userDataDir });
        expect(preloadDylib).toBeTruthy();
        expect(preloadDylib).toContain('libone_metal_preload.dylib');
        expect(fs.existsSync(preloadDylib)).toBe(true);

        // Verify doesWineLayerHaveMoltenVkHudDeadlock
        expect(launcherEngine.doesWineLayerHaveMoltenVkHudDeadlock(legacyWineBin)).toBe(true);
        expect(
          launcherEngine.doesWineLayerHaveMoltenVkHudDeadlock({ binaryPath: legacyWineBin })
        ).toBe(true);
        expect(launcherEngine.doesWineLayerHaveMoltenVkHudDeadlock(modernWineBin)).toBe(false);
        expect(
          launcherEngine.doesWineLayerHaveMoltenVkHudDeadlock({ binaryPath: modernWineBin })
        ).toBe(false);

        // Verify applyCrossOverPerGameSettings keeps MTL_HUD_ENABLED='1' and injects libone_metal_preload.dylib + ONE_LAUNCHER_MOLTENVK_PATH when deadlock symbol is present
        const legacyBottle = path.join(mockRoot, 'bottle-legacy');
        fs.mkdirSync(legacyBottle, { recursive: true });
        const legacyEnv: Record<string, string> = {};
        launcherEngine.applyCrossOverPerGameSettings(
          { type: 'wine', binaryPath: legacyWineBin },
          { metalHud: true },
          legacyEnv,
          legacyBottle,
          { userDataDir }
        );
        expect(legacyEnv.MTL_HUD_ENABLED).toBe('1');
        expect(legacyEnv.DYLD_INSERT_LIBRARIES).toContain('libone_metal_preload.dylib');
        expect(legacyEnv.ONE_LAUNCHER_MOLTENVK_PATH).toBe(legacyMvkDylib);

        // Verify applyCrossOverPerGameSettings cleans up MTL_HUD_ENABLED, ONE_LAUNCHER_MOLTENVK_PATH, and libone_metal_preload.dylib when metalHud is false
        launcherEngine.applyCrossOverPerGameSettings(
          { type: 'wine', binaryPath: legacyWineBin },
          { metalHud: false },
          legacyEnv,
          legacyBottle,
          { userDataDir }
        );
        expect(legacyEnv.MTL_HUD_ENABLED).toBeUndefined();
        expect(legacyEnv.ONE_LAUNCHER_MOLTENVK_PATH).toBeUndefined();
        expect(legacyEnv.DYLD_INSERT_LIBRARIES).toBeUndefined();

        // Verify applyCrossOverPerGameSettings sets MTL_HUD_ENABLED='1' without preload dylib when deadlock symbol is NOT present
        const modernBottle = path.join(mockRoot, 'bottle-modern');
        fs.mkdirSync(modernBottle, { recursive: true });
        const modernEnv: Record<string, string> = {};
        launcherEngine.applyCrossOverPerGameSettings(
          { type: 'crossover', binaryPath: modernWineBin },
          { metalHud: true },
          modernEnv,
          modernBottle,
          { userDataDir }
        );
        expect(modernEnv.MTL_HUD_ENABLED).toBe('1');
        expect(modernEnv.DYLD_INSERT_LIBRARIES).toBeUndefined();
        expect(modernEnv.ONE_LAUNCHER_MOLTENVK_PATH).toBeUndefined();

        // Verify resolveWineserverBinary resolves both adjacent bin/wineserver and ../bin/wineserver64
        expect(launcherEngine.resolveWineserverBinary(legacyWineBin)).toBe(legacyWineserver);
        expect(launcherEngine.resolveWineserverBinary(modernWineBin)).toBe(modernWineserver);
        expect(launcherEngine.resolveWineserverBinary(legacyWineserver)).toBe(legacyWineserver);
      } finally {
        try {
          fs.rmSync(mockRoot, { recursive: true, force: true });
        } catch {}
      }
    });

    it('resolves host display bounds via getHostMaxDisplayResolution and clamps out-of-bounds Retina-doubled .cfg and .ini resolutions via sanitizeWinePrefixDisplayConfigs idempotently', () => {
      const mockPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-display-sanitize-'));
      try {
        // 1. Verify getHostMaxDisplayResolution(true) vs getHostMaxDisplayResolution(false)
        const hiRes = launcherEngine.getHostMaxDisplayResolution(true, {
          maxWidth: 3024,
          maxHeight: 1964,
          logicalWidth: 1512,
          logicalHeight: 982,
        });
        expect(hiRes.width).toBe(3024);
        expect(hiRes.height).toBe(1964);
        expect(hiRes.logicalWidth).toBe(1512);
        expect(hiRes.logicalHeight).toBe(982);

        const loRes = launcherEngine.getHostMaxDisplayResolution(false, {
          maxWidth: 3024,
          maxHeight: 1964,
          logicalWidth: 1512,
          logicalHeight: 982,
        });
        expect(loRes.width).toBe(1512);
        expect(loRes.height).toBe(982);

        const hostResLive = launcherEngine.getHostMaxDisplayResolution(true);
        expect(hostResLive.width).toBeGreaterThanOrEqual(1280);
        expect(hostResLive.height).toBeGreaterThanOrEqual(720);
        const hostResLogicalLive = launcherEngine.getHostMaxDisplayResolution(false);
        expect(hostResLogicalLive.width).toBeGreaterThanOrEqual(640);
        expect(hostResLogicalLive.width).toBeLessThanOrEqual(hostResLive.width);

        // 2. Create a temporary Wine prefix with an out-of-bounds .cfg and .ini file
        const cfgFile = path.join(
          mockPrefix,
          'drive_c/users/crossover/Saved Games/SampleEngine/Game/kexengine.cfg'
        );
        writeTempFile(
          cfgFile,
          [
            'seta v_vsync "1"',
            'seta v_windowed "0"',
            'seta v_width "6048"',
            'seta v_height "3928"',
            'seta v_refresh "120"',
            '',
          ].join('\n')
        );

        const iniFile = path.join(
          mockPrefix,
          'drive_c/users/crossover/AppData/Local/SampleUEGame/Saved/Config/WindowsNoEditor/GameUserSettings.ini'
        );
        writeTempFile(
          iniFile,
          [
            '[/Script/Engine.GameUserSettings]',
            'ResolutionSizeX=7680',
            'ResolutionSizeY=4320',
            'LastUserConfirmedResolutionSizeX=7680',
            'LastUserConfirmedResolutionSizeY=4320',
            'FullscreenMode=0',
            '',
          ].join('\n')
        );

        const firstRun = launcherEngine.sanitizeWinePrefixDisplayConfigs(mockPrefix, {
          maxWidth: 3024,
          maxHeight: 1964,
          highResolutionMode: true,
        });
        expect(firstRun.maxWidth).toBe(3024);
        expect(firstRun.maxHeight).toBe(1964);
        expect(firstRun.sanitizedFiles).toHaveLength(2);

        const sanitizedCfgEntry = firstRun.sanitizedFiles.find(
          (f: any) => f.filePath === cfgFile
        );
        expect(sanitizedCfgEntry).toEqual({
          filePath: cfgFile,
          previousWidth: 6048,
          previousHeight: 3928,
          clampedWidth: 3024,
          clampedHeight: 1964,
        });

        const updatedCfgText = fs.readFileSync(cfgFile, 'utf8');
        expect(updatedCfgText).toContain('seta v_width "3024"');
        expect(updatedCfgText).toContain('seta v_height "1964"');
        expect(updatedCfgText).not.toContain('6048');

        const updatedIniText = fs.readFileSync(iniFile, 'utf8');
        expect(updatedIniText).toContain('ResolutionSizeX=3024');
        expect(updatedIniText).toContain('ResolutionSizeY=1964');
        expect(updatedIniText).toContain('LastUserConfirmedResolutionSizeX=3024');
        expect(updatedIniText).toContain('LastUserConfirmedResolutionSizeY=1964');

        // 3. Second run on already-clamped files must be idempotent (sanitizedFiles: [])
        const secondRun = launcherEngine.sanitizeWinePrefixDisplayConfigs(mockPrefix, {
          maxWidth: 3024,
          maxHeight: 1964,
          highResolutionMode: true,
        });
        expect(secondRun.sanitizedFiles).toEqual([]);
      } finally {
        try {
          fs.rmSync(mockPrefix, { recursive: true, force: true });
        } catch {}
      }
    });
  });
});

