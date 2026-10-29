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

describe("Universal Game Launcher QA — Scanning, Installers & Lifecycle (1–9)", () => {
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
            launchMethod: 'direct',
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

      // 2. Installed Game on GOG -> ActionBar shows Play button; SteamStorePage header shows clean Ready to Play pill near Owned on:
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

      // 3. Installed Windows Binary on macOS -> SteamStorePage header shows clean Ready to Play pill without CrossOver / Wine suffix
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
      expect(winOnMacPageHtml).not.toContain('CrossOver / Wine');

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
        `#!/usr/bin/env node
process.stderr.write("Fatal Error: Unable to initialize bottle\\n");
process.exit(1);
`,
        0o755
      );
      try {
        require('node:child_process').execFileSync(process.execPath, [crashScriptPath], {
          stdio: 'ignore',
        });
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
            startupWaitMs: 3000,
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
      const storeSyncMod = require('../../electron/storeSync.cjs');
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

      expect(multiBuildHtml).toContain('data-testid="install-option-mac-native"');
      expect(multiBuildHtml).toContain('data-testid="install-option-win-compat"');
      expect(multiBuildHtml).not.toContain('aria-label="Installer Build"');
      expect(multiBuildHtml).toContain('Native macOS Build');
      expect(multiBuildHtml).toContain('Windows Build (CrossOver / Wine)');
      expect(multiBuildHtml).toContain('(v1.5.0)');
      expect(multiBuildHtml).toContain('1.4 GB');
      expect(multiBuildHtml).not.toContain('((v');
      expect(multiBuildHtml).not.toContain('(Native))');
      expect(multiBuildHtml).toContain(
        '✓ Recommended: Official macOS build is available and auto-selected. Only choose the Windows (CrossOver / Wine) alternative if this game is an older 32-bit Mac port'
      );
    });

    it('deduplicates multi-language GOG installers per OS and strips duplicate v prefixes (e.g. Disco Elysium vsub29b) in getGameInstallInfo and GameInstallModal', async () => {
      const langs = ['de', 'fr', 'en', 'es', 'it', 'ru', 'zh'];

      // 1. Backend: 7 Windows language installers with version "vsub29b" -> deduplicated to 1 English installer with version "sub29b"
      const winOnlyMockProduct = {
        downloads: {
          installers: langs.map((lang, idx) => ({
            id: `de_win_${lang}_${idx}`,
            name: 'Disco Elysium',
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
          platformGameId: '1771589310',
          title: 'Disco Elysium',
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
          platformGameId: '1771589310',
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
      const discoGame: CanonicalGame = {
        id: 'gog-1771589310',
        title: 'Disco Elysium',
        sortTitle: 'Disco Elysium',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1771589310',
            installed: false,
          },
        ],
        headerImage: 'https://example.com/disco.jpg',
        developers: ['ZA/UM'],
        publishers: ['ZA/UM'],
        genres: ['RPG'],
        tags: ['Detective'],
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
              game: discoGame,
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
        platformGameId: '1771589310',
        hostPlatform: 'darwin',
        estimatedSizeBytes: 2362232012,
        defaultInstallDir: '/Users/test/Games/OneLauncher/GOG',
        availableInstallDirs: ['/Users/test/Games/OneLauncher/GOG'],
        availableInstallers: langs.map((lang, idx) => ({
          id: `de_win_${lang}_${idx}`,
          name: 'Disco Elysium — Windows Build',
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
        platformGameId: '1771589310',
        hostPlatform: 'darwin',
        estimatedSizeBytes: 2147483648,
        defaultInstallDir: '/Users/test/Games/OneLauncher/GOG',
        availableInstallDirs: ['/Users/test/Games/OneLauncher/GOG'],
        availableInstallers: [
          ...langs.map((lang, idx) => ({
            id: `dual_mac_${lang}_${idx}`,
            name: 'Disco Elysium — Native macOS Build',
            os: 'mac' as const,
            language: lang,
            totalSizeBytes: 2147483648,
            version: 'vsub29b',
          })),
          ...langs.map((lang, idx) => ({
            id: `dual_win_${lang}_${idx}`,
            name: 'Disco Elysium — Windows Build',
            os: 'windows' as const,
            language: lang,
            totalSizeBytes: 2362232012,
            version: 'vsub29b',
          })),
        ],
        canDirectDownload: true,
        requiresStoreClientFallback: false,
      });

      expect(fourteenDualInstallersHtml).toContain('data-testid="install-option-mac-native"');
      expect(fourteenDualInstallersHtml).toContain('data-testid="install-option-win-compat"');
      expect(fourteenDualInstallersHtml).not.toContain('aria-label="Installer Build"');
      expect(fourteenDualInstallersHtml).not.toContain('vvsub29b');
      expect(fourteenDualInstallersHtml).toContain('(vsub29b)');
      expect(fourteenDualInstallersHtml).toContain('2.0 GB');
      expect(fourteenDualInstallersHtml).toContain('2.2 GB');
    });
  });

});
