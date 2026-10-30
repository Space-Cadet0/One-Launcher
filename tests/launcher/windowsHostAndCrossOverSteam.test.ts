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

describe("Universal Game Launcher QA — Windows x64 Host & CrossOver Steam (10, 23, 24)", () => {
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
      const repoRoot = path.resolve(__dirname, '../..');

      // 1. Verify package.json NSIS uninstaller configuration (deleteAppDataOnUninstall: false for upgrade safety; customUnInstall handles explicit uninstall purge)
      const pkgPath = path.join(repoRoot, 'package.json');
      expect(fs.existsSync(pkgPath)).toBe(true);
      const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      expect(pkgJson.build?.nsis?.deleteAppDataOnUninstall).toBe(false);
      expect(pkgJson.build?.nsis?.include).toBe('build/installer.nsh');

      // 2. Verify single canonical Windows uninstaller source artifacts exist on disk (and release binary when built)
      const installerNshPath = path.join(repoRoot, 'build/installer.nsh');
      const standaloneNsiPath = path.join(repoRoot, 'build/standalone-uninstaller.nsi');
      const buildPs1Path = path.join(repoRoot, 'build/Uninstall-OneLauncher.ps1');
      const buildBatPath = path.join(repoRoot, 'build/Uninstall One Launcher (Full Clean).bat');
      const verifyScriptPath = path.join(
        repoRoot,
        'scripts/windows-uninstaller/verify-uninstaller.cjs'
      );
      const standaloneExePath = path.join(repoRoot, 'release/One Launcher Full Uninstaller.exe');

      expect(fs.existsSync(installerNshPath)).toBe(true);
      expect(fs.existsSync(standaloneNsiPath)).toBe(true);
      expect(fs.existsSync(buildPs1Path)).toBe(true);
      expect(fs.existsSync(buildBatPath)).toBe(true);
      expect(fs.existsSync(verifyScriptPath)).toBe(true);
      expect(
        fs.existsSync(path.join(repoRoot, 'scripts/windows-uninstaller/Uninstall-OneLauncher.ps1'))
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(repoRoot, 'scripts/windows-uninstaller/Uninstall One Launcher (Full Clean).bat')
        )
      ).toBe(false);
      if (fs.existsSync(standaloneExePath)) {
        expect(fs.statSync(standaloneExePath).size).toBeGreaterThan(10000);
      }

      const nshContent = fs.readFileSync(installerNshPath, 'utf8');
      const nsiContent = fs.readFileSync(standaloneNsiPath, 'utf8');
      const ps1Content = fs.readFileSync(buildPs1Path, 'utf8');
      const buildPs1Content = ps1Content;
      const batContent = fs.readFileSync(buildBatPath, 'utf8');

      const verifierMod = require(verifyScriptPath);
      expect(() => verifierMod.verifyFile(buildPs1Path, 'build/Uninstall-OneLauncher.ps1')).not.toThrow();
      expect(() =>
        verifierMod.verifyFile(buildBatPath, 'build/Uninstall One Launcher (Full Clean).bat')
      ).not.toThrow();

      // Verify NSIS customUnInstall macro in build/installer.nsh
      expect(nshContent).toContain('!macro customUnInstall');
      expect(nshContent).toContain('!macroend');

      // 3. Verify NSIS process termination, $PLUGINSDIR extraction (< 8192-byte NSIS_MAX_STRLEN), and NSIS directory/registry cleanup
      for (const content of [nshContent, nsiContent]) {
        expect(content).toContain('One Launcher.exe');
        expect(content).toContain('legendary.exe');
        expect(content).toContain('gogdl.exe');
        expect(content).toContain('File "/oname=$PLUGINSDIR\\Uninstall-OneLauncher.ps1"');
        expect(content).toContain('-File "$PLUGINSDIR\\Uninstall-OneLauncher.ps1"');
        expect(content).toContain('C:\\Games\\OneLauncher');
        expect(content).toContain('Games\\OneLauncher');
        expect(content).toContain('OneLauncher Games');
        expect(content).toContain('one-launcher');
        expect(content).toContain('One Launcher');
        expect(content).toContain('com.onelauncher.app');
        expect(content).toContain('one-launcher-updater');
        expect(content).toContain('.config\\legendary');
        expect(content).toContain('.config\\gogdl');
        expect(content).toContain('One Launcher.lnk');
        expect(content).toContain('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall');

        for (const line of content.split(/\r?\n/).filter((l) => l.trim().startsWith('nsExec::'))) {
          expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(2048);
        }
      }
      expect(ps1Content).toContain('"One Launcher"');
      expect(ps1Content).toContain('"legendary"');
      expect(ps1Content).toContain('"gogdl"');
      expect(ps1Content).toContain('$procName.exe');

      for (const content of [buildPs1Content, ps1Content, batContent]) {
        // Dynamic game installation manifest parsing + custom path/ID tracking
        expect(content).toContain('one_launcher_installed.json');
        expect(content).toContain('one_launcher_epic_imports.json');
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
        matchedStore: 'custom',
        title: 'Perf Test',
        updatedAt: '2026-01-01T00:00:00.000Z',
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
          1159093496,
          12511,
          1,
          JSON.stringify({
            items: [{ build_id: '12511', legacy_build_id: '23581250', generation: 1 }],
          })
        );
      seedDb.close();

      // Create <tempDir>/Celeste/Celeste.app with GOGLauncher wrapper and inner Celeste_64 64-bit Mach-O binary
      const celesteInstallDir = path.join(tempDir, 'Celeste');
      const outerAppPath = path.join(celesteInstallDir, 'Celeste.app');
      const outerLauncherBin = path.join(outerAppPath, 'Contents', 'MacOS', 'GOGLauncher');
      const innerGameBin = path.join(
        outerAppPath,
        'Contents',
        'Resources',
        'game',
        'Celeste.app',
        'Contents',
        'MacOS',
        'Celeste_64'
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
          'Celeste.app',
          'Contents',
          'Info.plist'
        ),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Celeste_64</string></dict></plist>`,
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
          platformGameId: '1159093496',
          title: 'Celeste',
          installPath: celesteInstallDir,
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
          .get(1159093496);
        expect(ibp).toBeTruthy();
        expect(ibp.installationPath).toBe(outerAppPath);
        expect(Number(ibp.generation)).toBe(1);
        expect(Number(ibp.buildId)).toBe(23581250);
        expect(ibp.branch).toBeNull();

        const bmt = verifyDb
          .prepare('SELECT * FROM BaseModificationTargets WHERE productId = ?')
          .get(1159093496);
        expect(bmt).toBeTruthy();
        expect(bmt.installationPath).toBe(outerAppPath);
        expect(Number(bmt.buildId)).toBe(23581250);
        expect(bmt.branch).toBeNull();

        const ps = verifyDb
          .prepare('SELECT * FROM ProductStates WHERE productId = ?')
          .get(1159093496);
        expect(ps).toBeTruthy();
        expect(Number(ps.installation)).toBe(3);
        expect(Number(ps.operation)).toBe(0);

        const pt = verifyDb
          .prepare(
            'SELECT ptlp.executablePath FROM PlayTasks pt JOIN PlayTaskLaunchParameters ptlp ON pt.id = ptlp.playTaskId WHERE pt.gameReleaseKey = ?'
          )
          .get('gog_1159093496');
        expect(pt).toBeTruthy();
        expect(pt.executablePath).toBe(innerGameBin);

        const pSettings = verifyDb
          .prepare('SELECT * FROM ProductSettings WHERE gameReleaseKey = ?')
          .get('gog_1159093496');
        expect(pSettings).toBeTruthy();
        expect(pSettings.gameReleaseKey).toBe('gog_1159093496');
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
      const storeSync = require('../../electron/storeSync.cjs');
      const { normalizeGogAvatarUrl: tsNormalize } = await import('../../src/services/integrations/gogIntegration');

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
      writeTempFile(mockCrossoverWine, '#!/usr/bin/env node\nprocess.exit(0);\n', 0o755);
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
        `#!/usr/bin/env node
const fs = require('node:fs');
const tmpDump = ${JSON.stringify(`${envDumpFile}.tmp`)};
fs.writeFileSync(
  tmpDump,
  JSON.stringify({
    exe: process.argv[2] || '',
    SteamAppId: process.env.SteamAppId || '',
    SteamGameId: process.env.SteamGameId || '',
    CX_BOTTLE: process.env.CX_BOTTLE || '',
  }) + '\\n',
  'utf8'
);
fs.renameSync(tmpDump, ${JSON.stringify(envDumpFile)});
setTimeout(() => process.exit(0), 1000);
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

      for (let i = 0; i < 100 && !fs.existsSync(envDumpFile); i++) {
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

      const zWinePath =
        'Z:\\\\' + hostExternalLib.replace(/^[a-zA-Z]:[\\/]/, '').replace(/[\\/]/g, '\\\\');
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
});
