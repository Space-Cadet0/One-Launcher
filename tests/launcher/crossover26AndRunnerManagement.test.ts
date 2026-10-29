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

describe("Universal Game Launcher QA — CrossOver 26, Bottle Uninstall & D3DMetal (25–30)", () => {
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
      expect(macPreview.defaultLaunchMethod).toBe('direct');
      expect(macPreview.availableModes).toEqual(['direct', 'storefront_uri']);
      expect(macPreview.modeNotes.direct.badge).toBe('Recommended');
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

      // 3. windows_native on win32 (Steam defaults to storefront_uri; Direct Binary is alternative)
      (globalThis as any).window.electronAPI = { platform: 'win32' };
      try {
        const winNativePreview = svc.resolveEffectiveLaunchModePreview(winExeOnMacGame, 'steam');
        expect(winNativePreview.detectedBuildType).toBe('windows_native');
        expect(winNativePreview.detectedBuildLabel).toContain('Windows Native Build (.exe)');
        expect(winNativePreview.autoResolvedMethod).toBe('storefront_uri');
        expect(winNativePreview.defaultLaunchMethod).toBe('storefront_uri');
        expect(winNativePreview.availableModes).toEqual(['storefront_uri', 'direct']);
        expect(winNativePreview.modeNotes.storefront_uri.badge).toBe('Recommended');
        expect(winNativePreview.modeNotes.direct.badge).toBe('Direct Binary');
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
        platform: 'darwin',
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
        platform: 'darwin',
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
        expect(gogPreview.availableModes).toEqual(['direct', 'storefront_uri']);
        expect(gogPreview.availableModes).not.toContain('auto');
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

        // Verify GOG native macOS .app DOES render native macOS Metal HUD section and exactly 2 native launch modes
        expect(gogRender.html).toContain('data-section="native-mac-settings"');
        expect(gogRender.html).toContain('Apple Metal Performance HUD (MTL_HUD_ENABLED=1)');
        expect(gogRender.html).toContain('Direct macOS Application (Recommended)');
        expect(gogRender.html).toContain('Storefront Client Protocol');
        expect(gogRender.html).not.toContain('Auto-Detect Native macOS Launch');
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
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(
  ${JSON.stringify(argsDumpFile)},
  JSON.stringify({
    exe: process.argv[2] || '',
    arg1: process.argv[3] || '',
    arg2: process.argv[4] || '',
    arg3: process.argv[5] || '',
    CX_BOTTLE: process.env.CX_BOTTLE || '',
    SteamAppId: process.env.SteamAppId || '',
  }) + '\\n',
  'utf8'
);
setTimeout(() => process.exit(0), 1000);
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

      for (let i = 0; i < 100 && !fs.existsSync(argsDumpFile); i++) {
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

    it('Bug 2: scanAllInstalledGames skips zero-executable CrossOver bottle ghosts non-destructively (read-only scanner) while uninstallGame cleans them up on disk', async () => {
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

      // Zero-Mutation Read-Only Scanner Invariant (D7.1): scanAllInstalledGames skips ghost installs without deleting user files on disk
      expect(fs.existsSync(acfPath)).toBe(true);
      expect(fs.existsSync(gameCommonDir)).toBe(true);
      expect(fs.existsSync(saveFileOnly)).toBe(true);
      expect(fs.existsSync(quakeAppDir)).toBe(true);
      expect(fs.existsSync(steamAppDir)).toBe(true);

      // Explicit uninstallGame performs full disk & bottle manifest cleanup while preserving Steam.app
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
        }
      );
      expect(uninstallRes.success).toBe(true);
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
    it('1. verifies discontinued Whisky is completely removed from detectCompatibilityLayers and GameLaunchConfigModal while legacy saved configs normalize whisky -> crossover', () => {
      const detected = launcherEngine.detectCompatibilityLayers({
        platform: 'darwin',
        homedir: tmpRoot,
      });
      const layerTypes = (Array.isArray(detected) ? detected : detected?.layers || []).map(
        (l: any) => String(l.type || l.id || '').toLowerCase()
      );
      expect(layerTypes).not.toContain('whisky');

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

      // B. macOS with Native macOS .app installed (mac_native_app, GOG) -> ONLY ['direct', 'storefront_uri']
      const macNativePreview = launcherService.resolveEffectiveLaunchModePreview(
        macNativeAppGame,
        'gog'
      );
      expect(macNativePreview.detectedBuildType).toBe('mac_native_app');
      expect(macNativePreview.availableModes).toEqual(['direct', 'storefront_uri']);
      expect(macNativePreview.availableModes).not.toContain('auto');
      expect(macNativePreview.availableModes).not.toContain('compatibility_layer');

      // C. Windows (win32, Steam) -> ONLY ['storefront_uri', 'direct']
      (globalThis as any).window.electronAPI = { platform: 'win32' };
      try {
        const win32Preview = launcherService.resolveEffectiveLaunchModePreview(
          winExeOnMacGame,
          'steam'
        );
        expect(win32Preview.detectedBuildType).toBe('windows_native');
        expect(win32Preview.availableModes).toEqual(['storefront_uri', 'direct']);
        expect(win32Preview.availableModes).not.toContain('auto');
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

        const svcRes = await launcherService.installCompatibilityLayer('wine', 'brew' as any);
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
      const { GameLaunchConfigModal } = await import('../../src/components/Launcher/GameLaunchConfigModal'
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
        .mockResolvedValue({});

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
});
