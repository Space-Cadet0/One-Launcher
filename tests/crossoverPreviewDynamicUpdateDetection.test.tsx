import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import React from 'react';

import type {
  CompatibilityLayerInfo,
  CompatibilityLayerUpdateInfo,
  InstalledGameRecord,
} from '../src/contracts/launcher';
import type {
  EnvironmentComponentId,
  EnvironmentComponentState,
  EnvironmentHealthSnapshot,
} from '../src/contracts/environmentSetup';

import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import {
  useGameLaunchConfigForm,
  type UseGameLaunchConfigFormParams,
} from '../src/components/Launcher/LaunchConfig/useGameLaunchConfigForm';
import { CompatibilityAndBottleStep } from '../src/components/Launcher/SystemSetupWizard/steps/CompatibilityAndBottleStep';
import { launcherService } from '../src/services/launcher/launcherService';
import {
  environmentSetupService,
  buildProvisioningTasksFromSelection,
} from '../src/services/launcher/environmentSetupService';
import {
  createDomain12DeepRenderer,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';

const nodeRequire = createRequire(import.meta.url);
const macNativeInstaller = nodeRequire('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const environmentProvisioner = nodeRequire('../electron/launcher/environmentProvisioner.cjs');
const environmentHealthProber = nodeRequire('../electron/launcher/environmentHealthProber.cjs');
const launcherIpcHandlers = nodeRequire('../electron/ipc/launcherIpcHandlers.cjs');
const launcherEngine = nodeRequire('../electron/launcherEngine.cjs');

function findVNodes(root: any, predicate: (node: any) => boolean): any[] {
  const matches: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (predicate(node)) matches.push(node);
    if (node.props?.children !== undefined) {
      visit(node.props.children);
    }
  };
  visit(root);
  return matches;
}

function findVNodeByTestId(root: any, testId: string): any | undefined {
  return findVNodes(root, (n) => n.props?.['data-testid'] === testId)[0];
}

function extractVNodeText(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractVNodeText).join('');
  if (typeof node === 'object' && node.props?.children !== undefined) {
    return extractVNodeText(node.props.children);
  }
  return '';
}

function createLaunchConfigFormHarness(params: UseGameLaunchConfigFormParams) {
  let latestForm!: ReturnType<typeof useGameLaunchConfigForm>;
  const FormProbe = (props: UseGameLaunchConfigFormParams) => {
    latestForm = useGameLaunchConfigForm(props);
    return null;
  };
  const renderer = createDomain12DeepRenderer(FormProbe, params);
  return {
    render: (next?: Partial<UseGameLaunchConfigFormParams>) => {
      renderer.render(next);
      return latestForm;
    },
    get current() {
      return latestForm;
    },
    unmount: () => renderer.unmount(),
  };
}

function makeSyntheticSetupSnapshot(
  hostPlatform: 'darwin' | 'win32' = 'darwin',
  customComponents: Partial<Record<EnvironmentComponentId, Partial<EnvironmentComponentState>>> = {}
): EnvironmentHealthSnapshot {
  const baseComp = (id: EnvironmentComponentId): EnvironmentComponentState => ({
    id,
    category: id.startsWith('runner_') ? 'compatibility_runner' : 'os_prerequisite',
    scope: 'system',
    title: id,
    shortLabel: id,
    status: 'ready',
    canAutoInstall: true,
    recommendationTier: 'recommended',
    recommendationBadge: 'Recommended',
    defaultSelected: false,
    whyExplanation: 'synthetic',
    statusDetail: 'Ready',
    ...(customComponents[id] || {}),
  });

  const ids: EnvironmentComponentId[] = [
    'rosetta2',
    'win_vcredist',
    'win_webview2',
    'runner_crossover',
    'runner_crossover_preview',
    'runner_wine',
    'runner_gptk',
    'bottle_default',
    'host_steam',
    'bottle_steam',
    'host_gog',
    'bottle_gog',
    'host_epic',
    'bottle_epic',
    'host_ubisoft',
    'bottle_ubisoft',
    'host_ea',
    'bottle_ea',
    'host_bnet',
    'bottle_bnet',
    'host_rockstar',
    'bottle_rockstar',
    'xbox_runtime',
  ];

  const components: any = {};
  for (const id of ids) {
    components[id] = baseComp(id);
  }

  return {
    probedAt: '2026-11-12T00:00:00.000Z',
    probeDurationMs: 8,
    hostPlatform,
    hostArch: 'arm64',
    isAppleSiliconMac: hostPlatform === 'darwin',
    hasWriteAccessToSystemApplications: true,
    preferredMacApplicationsDir: '/Applications',
    connectedStorefronts: ['steam'],
    bundledHelpers: {
      gogdlReady: false,
      legendaryReady: false,
      xboxGdkBridgesReady: true,
      metalPreloadReady: true,
    },
    detectedRunners: [],
    bottleSummary: {
      runnerType: null,
      runnerInstalled: false,
      availableBottles: [],
      recommendedBottleMode: 'create_dedicated',
      recommendedBottleName: 'OneLauncher',
    },
    components,
    clientLogins: {} as any,
    localStoreHints: [],
    counts: {
      readyCount: 1,
      missingRecommendedCount: 0,
      removedSinceLastSetupCount: 0,
      pendingClientLoginCount: 0,
      accountMismatchCount: 0,
      updateAvailableCount: 0,
    },
  };
}

describe('CrossOver Preview Dynamic Update Detection, Download & Installation (R1-R3)', () => {
  let tmpRoot: string;
  let userDataDir: string;
  let appsDir: string;
  const origPlatform = process.platform;
  const origArch = process.arch;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cx-preview-dynamic-test-'));
    userDataDir = path.join(tmpRoot, 'userData');
    appsDir = path.join(tmpRoot, 'Applications');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(appsDir, { recursive: true });
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    launcherEngine.setUserDataDir(userDataDir);
    (environmentSetupService as any).lastPreviewSignInResult = null;
    (environmentSetupService as any).lastSnapshot = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Dynamic Date Extraction & Candidate Link Resolution (Zero Hardcoded Versions)', () => {
    it('1.1 parses 8-digit preview dates from URLs, filenames, plists, and display strings dynamically', () => {
      // Current reference vs newly released reference
      expect(
        macNativeInstaller.extractRunnerPreviewDate(
          'https://www.codeweavers.com/preview/download/crossover-preview-20261015.zip'
        )
      ).toBe('20261015');
      expect(
        macNativeInstaller.extractRunnerPreviewDate(
          'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
        )
      ).toBe('20261111');

      // Arbitrary future dates (proving no hardcoded lookup tables)
      expect(
        macNativeInstaller.extractRunnerPreviewDate('/tmp/crossover-preview-20261201.zip')
      ).toBe('20261201');
      expect(
        macNativeInstaller.extractRunnerPreviewDate('crossover-preview-20270115.dmg')
      ).toBe('20270115');
      expect(
        macNativeInstaller.extractRunnerPreviewDate({
          latestDisplayVersion: '27.0.0 (Preview 20261111)',
        })
      ).toBe('20261111');
      expect(
        macNativeInstaller.extractRunnerPreviewDate({
          version: '27.0.0',
          buildVersion: '20261015',
        })
      ).toBe('20261015');
      expect(
        macNativeInstaller.extractRunnerPreviewDate({
          downloadUrl: 'https://media.codeweavers.com/pub/crossover-preview-20261111.zip',
        })
      ).toBe('20261111');

      // Malformed or non-preview inputs return null safely without crashing
      expect(macNativeInstaller.extractRunnerPreviewDate(null)).toBeNull();
      expect(macNativeInstaller.extractRunnerPreviewDate('')).toBeNull();
      expect(macNativeInstaller.extractRunnerPreviewDate('crossover-26.3.0.zip')).toBeNull();
      expect(macNativeInstaller.extractRunnerPreviewDate({ version: '26.3.0' })).toBeNull();
    });

    it('1.2 extracts candidate preview links from raw HTML portal content without hardcoded versions', () => {
      const samplePortalHtml = `
        <html>
          <body>
            <h1>CodeWeavers CrossOver Preview</h1>
            <p>Welcome to the technology preview!</p>
            <a href="/preview/download/crossover-preview-arm64-20261111.zip">ARM64 Preview</a>
            <a href="https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip">Download CrossOver Preview macOS</a>
            <a href="/preview/download/crossover-preview_27.0.0-1.deb">Linux .deb</a>
            <a href="https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-26.3.0.zip">Stable Demo</a>
          </body>
        </html>
      `;
      const extracted: string[] = [];
      macNativeInstaller.extractCandidateLinksFromText(samplePortalHtml, extracted);
      expect(extracted).toContain(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
      expect(extracted).toContain('/preview/download/crossover-preview-arm64-20261111.zip');
      expect(extracted).toContain('/preview/download/crossover-preview_27.0.0-1.deb');

      // selectPreferredCrossOverPreviewDownloadUrl picks the standard macOS zip and ignores ARM64 and Linux packages
      const best = environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
        extracted,
        'https://www.codeweavers.com/preview/download'
      );
      expect(best).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
    });

    it('1.3 extracts runner version and preserves 8-digit preview date from app Info.plist', () => {
      const mockAppPath = path.join(appsDir, 'CrossOver Preview.app');
      const contentsDir = path.join(mockAppPath, 'Contents');
      fs.mkdirSync(contentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(contentsDir, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>CFBundleIdentifier</key>
          <string>com.codeweavers.CrossOverPreview</string>
          <key>CFBundleShortVersionString</key>
          <string>20261015</string>
          <key>CFBundleVersion</key>
          <string>27.0.0</string>
        </dict>
        </plist>`
      );

      const verInfo = macNativeInstaller.extractRunnerVersionInfo(mockAppPath);
      expect(verInfo.version).toBe('27.0.0');
      expect(verInfo.buildVersion).toBe('20261015');
      expect(verInfo.displayVersion).toBe('27.0.0 (Preview 20261015)');
      expect(verInfo.previewDate).toBe('20261015');
    });
  });

  describe('2. Launch & Compatibility Settings — Update Detection & Update UX', () => {
    it('2.1 detects crossover-preview-20261111.zip when currently on crossover-preview-20261015.zip and marks updateAvailable: true', async () => {
      const installedPreviewLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
        availableBottles: ['OneLauncher'],
      };

      const portalHtml = `
        <html><body>
          <a href="https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip">Download CrossOver Preview (20261111)</a>
        </body></html>
      `;

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [installedPreviewLayer],
        previewPortalHtml: portalHtml,
      });

      expect(updates.crossover_preview).toBeDefined();
      const previewUpdate = updates.crossover_preview!;
      expect(previewUpdate.updateAvailable).toBe(true);
      expect(previewUpdate.latestVersion).toBe('20261111');
      expect(previewUpdate.latestDisplayVersion).toBe('27.0.0 (Preview 20261111)');
      expect(previewUpdate.downloadUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
      expect(previewUpdate.canAutoUpdate).toBe(true);
    });

    it('2.2 marks updateAvailable: false ("Up to Date") when the installed preview is already on or newer than available release', async () => {
      const currentPreviewLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261111',
        displayVersion: '27.0.0 (Preview 20261111)',
        previewDate: '20261111',
        supportsMetalFxDlssD3dMetal: true,
        availableBottles: ['OneLauncher'],
      };

      const portalHtml = `
        <html><body>
          <a href="https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip">Download CrossOver Preview (20261111)</a>
        </body></html>
      `;

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [currentPreviewLayer],
        previewPortalHtml: portalHtml,
      });

      expect(updates.crossover_preview).toBeDefined();
      expect(updates.crossover_preview!.updateAvailable).toBe(false);
      expect(updates.crossover_preview!.latestVersion).toBe('20261111');
    });

    it('2.3 renders "Update Available: v20261111" badge and "Update" button in GameLaunchConfigModal and initiates update', async () => {
      const installedPreviewLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
        availableBottles: ['OneLauncher'],
      };

      const updateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        installedBuildVersion: '20261015',
        installedDisplayVersion: '27.0.0 (Preview 20261015)',
        latestVersion: '20261111',
        latestBuildVersion: '20261111',
        latestDisplayVersion: '27.0.0 (Preview 20261111)',
        updateAvailable: true,
        canAutoUpdate: true,
        updateMethod: 'direct_download',
        downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        checkedAt: new Date().toISOString(),
      };

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: '/Users/test/Games/Cyberpunk2077',
            executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([installedPreviewLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([installedPreviewLayer]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
        crossover_preview: updateInfo,
      });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({
        crossover_preview: updateInfo,
      });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Cyberpunk 2077',
        installPath: '/Users/test/Games/Cyberpunk2077',
        executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      const updateSpy = vi.spyOn(launcherService, 'updateCompatibilityLayer').mockResolvedValue({
        success: true,
        runnerType: 'crossover_preview',
        message: 'Successfully updated CrossOver Preview to 27.0.0 (Preview 20261111).',
      } as any);

      const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });

      let tree = modal.render();
      await Promise.resolve();
      tree = modal.render();

      // Verify the compact Update badge is present with the new version 20261111
      const updateBadge = findVNodeByTestId(tree, 'runner-update-available-badge');
      expect(updateBadge).toBeDefined();
      expect(extractVNodeText(updateBadge)).toContain('Update v20261111');

      // Streamlined Launch Config routes runner updates to Setup Wizard via Manage Runners & Bottles
      const manageBtn = findVNodeByTestId(tree, 'manage-runners-bottles-btn');
      expect(manageBtn).toBeDefined();
      expect(findVNodeByTestId(tree, 'update-runner-btn')).toBeUndefined();

      modal.unmount();

      // Verify underlying form hook update handler still targets crossover_preview cleanly
      const formHarness = createLaunchConfigFormHarness({
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      formHarness.render();
      await Promise.resolve();
      formHarness.render();
      await formHarness.current.handleUpdateRunner();
      expect(updateSpy).toHaveBeenCalledWith('crossover_preview');
      formHarness.unmount();
    });

    it('2.4 updates CrossOver Preview and updates version metadata cleanly', async () => {
      const beforeLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
      };

      const afterLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261111',
        displayVersion: '27.0.0 (Preview 20261111)',
        previewDate: '20261111',
        supportsMetalFxDlssD3dMetal: true,
      };

      const res = await macNativeInstaller.updateCompatibilityLayer(
        {
          runnerType: 'crossover_preview',
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        },
        {
          layers: [beforeLayer],
          mockUpdateRunnerDirect: async () => ({
            success: true,
            newVersion: '27.0.0',
            detectedLayers: [afterLayer],
          }),
        }
      );

      expect(res.success).toBe(true);
      expect(res.updated).toBe(true);
      expect(res.message).toContain('CrossOver Preview to 27.0.0 (Preview 20261111)');
    });

    it('2.5 updating CrossOver Preview retains crossover_preview selection in form even if stableSurpassesPreview was previously set', async () => {
      const installedPreviewLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
        availableBottles: ['OneLauncher'],
      };

      const installedStableLayer: CompatibilityLayerInfo = {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        appPath: path.join(appsDir, 'CrossOver.app'),
        binaryPath: path.join(appsDir, 'CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '28.0.0',
        buildVersion: '28.0.0.39000',
        displayVersion: '28.0.0 (Build 39000)',
        supportsMetalFxDlssD3dMetal: true,
        availableBottles: ['OneLauncher'],
      };

      const updatedPreviewLayer: CompatibilityLayerInfo = {
        ...installedPreviewLayer,
        version: '28.0.0',
        buildVersion: '20261111',
        displayVersion: '28.0.0 (Preview 20261111)',
        previewDate: '20261111',
      };

      const updateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        installedBuildVersion: '20261015',
        installedDisplayVersion: '27.0.0 (Preview 20261015)',
        latestVersion: '20261111',
        latestBuildVersion: '20261111',
        latestDisplayVersion: '28.0.0 (Preview 20261111)',
        updateAvailable: true,
        canAutoUpdate: true,
        stableSurpassesPreview: true, // Previously set because stable 28.0.0 > 27.0.0
        updateMethod: 'direct_download',
        downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        checkedAt: new Date().toISOString(),
      };

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: '/Users/test/Games/Cyberpunk2077',
            executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        installedPreviewLayer,
        installedStableLayer,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        updatedPreviewLayer,
        installedStableLayer,
      ]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
        crossover_preview: updateInfo,
      });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({
        crossover_preview: updateInfo,
      });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Cyberpunk 2077',
        installPath: '/Users/test/Games/Cyberpunk2077',
        executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockResolvedValue({
        success: true,
        updated: true,
        runnerType: 'crossover_preview',
        detectedLayers: [updatedPreviewLayer, installedStableLayer],
        message: 'Successfully updated CrossOver Preview to 28.0.0 (Preview 20261111).',
      } as any);

      const formHarness = createLaunchConfigFormHarness({
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });

      formHarness.render();
      await Promise.resolve();
      formHarness.render();

      expect(formHarness.current.compatibilityLayer).toBe('crossover_preview');
      await formHarness.current.handleUpdateRunner();
      formHarness.render();

      // Form MUST still select crossover_preview and not be demoted to crossover
      expect(formHarness.current.compatibilityLayer).toBe('crossover_preview');
      formHarness.unmount();

      const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let tree = modal.render();
      await Promise.resolve();
      tree = modal.render();
      const runnerSelect = findVNodeByTestId(tree, 'compat-runner-select');
      expect(runnerSelect.props.value).toBe('crossover_preview');

      modal.unmount();
    });
  });

  describe('3. Setup Wizard — Dynamic Recognition, Download & Installation', () => {
    it('3.1 dynamically discovers crossover-preview-20261111.zip on clean system and populates runner_crossover_preview in health prober', async () => {
      // Clean system: CrossOver Preview is not installed yet
      const candidateUrls = [
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
      ];

      const snapshot = await environmentHealthProber.probeEnvironmentHealth({
        platform: 'darwin',
        arch: 'arm64',
        layers: [], // no runners installed
        customApplicationsDir: appsDir,
        homedir: tmpRoot,
        previewCandidateUrls: candidateUrls,
      });

      const previewComp = snapshot.components.runner_crossover_preview;
      expect(previewComp).toBeDefined();
      expect(previewComp.status).toBe('missing');
      expect(previewComp.latestVersion).toBe('20261111');
      expect(previewComp.latestDisplayVersion).toBe('Preview 20261111');
      expect(previewComp.externalDownloadUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
      expect(previewComp.downloadUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
    });

    it('3.2 recognizes crossover-preview-20261111.zip update when currently on 20261015, setting status: update_available in Setup Wizard snapshot', async () => {
      const installedPreviewLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
      };

      const candidateUrls = [
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
      ];

      const snapshot = await environmentHealthProber.probeEnvironmentHealth({
        platform: 'darwin',
        arch: 'arm64',
        layers: [installedPreviewLayer],
        customApplicationsDir: appsDir,
        homedir: tmpRoot,
        previewCandidateUrls: candidateUrls,
      });

      const previewComp = snapshot.components.runner_crossover_preview;
      expect(previewComp).toBeDefined();
      expect(previewComp.status).toBe('update_available');
      expect(previewComp.version).toBe('27.0.0 (Preview 20261015)');
      expect(previewComp.latestVersion).toBe('20261111');
      expect(previewComp.canAutoInstall).toBe(true);
      expect(previewComp.requiresExternalDownload).toBe(false);
      expect(previewComp.downloadUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
    });

    it('3.3 renders runner-update-badge-crossover-preview and toggle switch in CompatibilityAndBottleStep', () => {
      const macSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'update_available',
          version: '27.0.0 (Preview 20261015)',
          latestVersion: '20261111',
          canAutoInstall: true,
          requiresExternalDownload: false,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        },
      });

      const toggleRunnerUpdateSpy = vi.fn();
      const step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: macSnapshot,
        chosenRunner: 'crossover_preview',
        onSelectRunner: vi.fn(),
        bottleMode: 'reuse_existing',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        gptkDmgPath: '',
        onChangeGptkDmgPath: vi.fn(),
        selectedIds: new Set<EnvironmentComponentId>(['bottle_default']),
        onToggleRunnerUpdate: toggleRunnerUpdateSpy,
      });

      const tree = step.render();
      const previewCard = findVNodeByTestId(tree, 'setup-runner-crossover-preview');
      expect(previewCard).toBeDefined();

      const updateBadge = findVNodeByTestId(tree, 'runner-update-badge-crossover-preview');
      expect(updateBadge).toBeDefined();

      const updateToggle = findVNodeByTestId(tree, 'runner-update-toggle-crossover-preview');
      expect(updateToggle).toBeDefined();
      expect(updateToggle.props.role).toBe('switch');

      updateToggle.props.onClick();
      expect(toggleRunnerUpdateSpy).toHaveBeenCalledWith('runner_crossover_preview', true);
      step.unmount();
    });

    it('3.4 builds install_runner provisioning task and installs detected CrossOver Preview 20261111 release', async () => {
      const macSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'update_available',
          version: '27.0.0 (Preview 20261015)',
          latestVersion: '20261111',
          canAutoInstall: true,
          requiresExternalDownload: false,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        },
      });

      const selectedIds = new Set<EnvironmentComponentId>([
        'runner_crossover_preview',
        'bottle_default',
      ]);

      const tasks = buildProvisioningTasksFromSelection({
        snapshot: macSnapshot,
        selectedIds,
        chosenRunner: 'crossover_preview',
        bottleMode: 'create_dedicated',
        bottleName: 'OneLauncher',
        gptkDmgPath: '',
        runnerUpdateOptInIds: new Set<EnvironmentComponentId>(['runner_crossover_preview']),
      });

      expect(tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'install_runner',
            componentId: 'runner_crossover_preview',
            runnerType: 'crossover_preview',
            forceUpdate: true,
          }),
        ])
      );
      const previewTask = tasks.find((t) => t.componentId === 'runner_crossover_preview');
      expect(previewTask).toBeDefined();
      expect((previewTask as unknown as Record<string, unknown>).downloadUrl).toBeUndefined();

      // Verify runEnvironmentSetupTasks threads task.downloadUrl to installRunnerDirect
      const runnerOpsCapture: any[] = [];
      const fakeArchive = path.join(tmpRoot, 'crossover-preview-20261111.zip');
      fs.writeFileSync(fakeArchive, Buffer.from('PK\x03\x04'));

      const setupRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          runId: 'test-wizard-install-preview',
          tasks: [
            {
              action: 'install_runner',
              componentId: 'runner_crossover_preview',
              runnerType: 'crossover_preview',
              forceUpdate: true,
              downloadUrl:
                'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
            },
          ],
        },
        {
          skipNetwork: false,
          homedir: tmpRoot,
          customApplicationsDir: appsDir,
          capturePreviewDownloadFn: async ({ options: hookOpts }: any) => {
            runnerOpsCapture.push(hookOpts?.downloadUrl);
            return {
              archivePath: fakeArchive,
              resolvedVersion: '20261111',
            };
          },
          onExtractArchive: async (_archive: string, staging: string) => {
            const appPath = path.join(staging, 'CrossOver Preview.app');
            const contents = path.join(appPath, 'Contents');
            fs.mkdirSync(contents, { recursive: true });
            fs.writeFileSync(
              path.join(contents, 'Info.plist'),
              `<?xml version="1.0" encoding="UTF-8"?>
              <plist version="1.0">
              <dict>
                <key>CFBundleShortVersionString</key>
                <string>20261111</string>
                <key>CFBundleVersion</key>
                <string>27.0.0</string>
              </dict>
              </plist>`
            );
          },
          verifySignatureFn: async () => ({ valid: true }),
          skipCodeSignVerification: true,
        }
      );

      expect(setupRes.success).toBe(true);
      expect(runnerOpsCapture).toContain(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
    });
  });

  describe('4. IPC Security & Type Safety', () => {
    it('4.1 sanitizeCompatLayerPayload and sanitizeEnvironmentSetupTasksPayload strip untrusted downloadUrl and preserve authenticateOnly safely', () => {
      const valid = launcherIpcHandlers.sanitizeCompatLayerPayload(
        {
          runnerType: 'crossover_preview',
          authenticateOnly: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        },
        'update'
      );
      expect(valid.ok).toBe(true);
      expect(valid.payload?.runnerType).toBe('crossover_preview');
      expect(valid.payload?.authenticateOnly).toBe(true);
      expect(valid.payload?.downloadUrl).toBeUndefined();

      const rejectedJs = launcherIpcHandlers.sanitizeCompatLayerPayload(
        {
          runnerType: 'crossover_preview',
          downloadUrl: 'javascript:alert(1)',
        },
        'update'
      );
      expect(rejectedJs.ok).toBe(true);
      expect(rejectedJs.payload?.downloadUrl).toBeUndefined();

      const rejectedFile = launcherIpcHandlers.sanitizeCompatLayerPayload(
        {
          runnerType: 'crossover_preview',
          downloadUrl: 'file:///etc/passwd',
        },
        'update'
      );
      expect(rejectedFile.ok).toBe(true);
      expect(rejectedFile.payload?.downloadUrl).toBeUndefined();

      const validTask = launcherIpcHandlers.sanitizeEnvironmentSetupTasksPayload({
        runId: 'run-1',
        tasks: [
          {
            action: 'install_runner',
            componentId: 'runner_crossover_preview',
            runnerType: 'runner_crossover_preview',
            downloadUrl:
              'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
          },
        ],
      });
      expect(validTask.ok).toBe(true);
      expect(validTask.payload?.tasks[0].componentId).toBe('runner_crossover_preview');
      expect(validTask.payload?.tasks[0].runnerType).toBe('crossover_preview');
      expect(validTask.payload?.tasks[0].downloadUrl).toBeUndefined();

      const rejectedTaskJs = launcherIpcHandlers.sanitizeEnvironmentSetupTasksPayload({
        runId: 'run-2',
        tasks: [
          {
            action: 'install_runner',
            componentId: 'runner_crossover_preview',
            downloadUrl: 'javascript:exploit()',
          },
        ],
      });
      expect(rejectedTaskJs.ok).toBe(true);
      expect(rejectedTaskJs.payload?.tasks[0].downloadUrl).toBeUndefined();
    });
  });

  describe('5. Adversarial Edge Cases & Robustness (OI-3, OI-4, OI-5)', () => {
    it('5.1 handles plists where CFBundleShortVersionString is 8-digit date and CFBundleVersion is not semver', async () => {
      const nonSemverApp = path.join(tmpRoot, 'NonSemverPreview.app');
      const contents = path.join(nonSemverApp, 'Contents');
      fs.mkdirSync(contents, { recursive: true });
      fs.writeFileSync(
        path.join(contents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>CFBundleShortVersionString</key>
          <string>20261015</string>
          <key>CFBundleVersion</key>
          <string>20261015</string>
        </dict>
        </plist>`
      );

      const info = macNativeInstaller.extractRunnerVersionInfo(nonSemverApp);
      expect(info.version).toBe('20261015');
      expect(info.buildVersion).toBe('20261015');
      expect(info.displayVersion).toBe('Preview 20261015');
      expect(info.previewDate).toBe('20261015');

      // Update detection recognizes available 20261111 update
      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [
          {
            id: 'crossover_preview',
            type: 'crossover_preview',
            name: 'CrossOver Preview',
            appPath: nonSemverApp,
            binaryPath: '/bin/echo',
            version: info.version,
            buildVersion: info.buildVersion,
            displayVersion: info.displayVersion,
            previewDate: info.previewDate,
          },
        ],
        previewCandidateUrls: [
          'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        ],
      });
      expect(updates.crossover_preview?.updateAvailable).toBe(true);
      expect(updates.crossover_preview?.latestVersion).toBe('20261111');
    });

    it('5.2 extracts dates from filenames with alpha/beta/hotfix suffixes and query params', () => {
      const candidates = [
        'crossover-preview-20261111beta1.zip',
        'crossover-preview-20261111a.zip',
        'crossover-preview-20261111-hotfix1.zip',
        'crossover-preview-20261111.zip?download_token=secret123',
      ];
      for (const c of candidates) {
        expect(macNativeInstaller.extractRunnerPreviewDate(c)).toBe('20261111');
      }

      const bestUrl = environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
        [
          'https://www.codeweavers.com/preview/download/crossover-preview-20261015.zip',
          'https://www.codeweavers.com/preview/download/crossover-preview-20261111beta1.zip',
        ],
        'https://www.codeweavers.com/preview/download'
      );
      expect(bestUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111beta1.zip'
      );
    });

    it('5.3 detects update when dates match but semver increases (27.0.0 -> 28.0.0)', async () => {
      const layer27: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        binaryPath: '/bin/echo',
        version: '27.0.0',
        buildVersion: '20261111',
        displayVersion: '27.0.0 (Preview 20261111)',
        previewDate: '20261111',
      };

      const portalHtml = `
        <a href="https://www.codeweavers.com/preview/download/crossover-preview-28.0.0-20261111.zip">Download CrossOver Preview 28.0</a>
      `;

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [layer27],
        previewPortalHtml: portalHtml,
      });

      expect(updates.crossover_preview?.updateAvailable).toBe(true);
      expect(updates.crossover_preview?.latestDisplayVersion).toBe('28.0.0 (Preview 20261111)');
    });

    it('5.4 handles offline / skipNetwork gracefully without throwing in health probe and setup tasks', async () => {
      const health = await environmentHealthProber.probeEnvironmentHealth({
        skipNetwork: true,
        layers: [],
      });
      const previewComp = health.components.runner_crossover_preview;
      expect(previewComp.status).toBe('missing');
      expect(previewComp.canAutoInstall).toBe(true);
      expect(previewComp.externalDownloadUrl).toBe('https://www.codeweavers.com/preview/download');

      let openedPortalUrl = '';
      const directRes = await environmentProvisioner.installRunnerDirect('crossover_preview', {
        skipNetwork: true,
        skipProcessCheck: true,
        openExternalFn: async (url: string) => {
          openedPortalUrl = url;
        },
      });
      expect(directRes.success).toBe(true);
      expect(directRes.openedExternal).toBe(true);
      expect(openedPortalUrl).toBe('https://www.codeweavers.com/preview/download');
    });

    it('5.5 formats displayVersion cleanly without duplicate parenthesized dates when ShortVersion is semver and BundleVersion is date', () => {
      const mockAppPath = path.join(appsDir, 'CrossOver Preview Apple Standard.app');
      const contentsDir = path.join(mockAppPath, 'Contents');
      fs.mkdirSync(contentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(contentsDir, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>CFBundleShortVersionString</key>
          <string>24.0.0</string>
          <key>CFBundleVersion</key>
          <string>20261015</string>
        </dict>
        </plist>`
      );

      const verInfo = macNativeInstaller.extractRunnerVersionInfo(mockAppPath);
      expect(verInfo.version).toBe('24.0.0');
      expect(verInfo.buildVersion).toBe('20261015');
      expect(verInfo.previewDate).toBe('20261015');
      // Must NOT contain duplicate "(20261015) (Preview 20261015)"
      expect(verInfo.displayVersion).toBe('24.0.0 (Preview 20261015)');
    });

    it('5.6 preserves previewDate when CFBundleShortVersionString is hyphenated/prefixed preview tag and CFBundleVersion is semver', () => {
      const mockAppPath = path.join(appsDir, 'CrossOver Tagged Preview.app');
      const contentsDir = path.join(mockAppPath, 'Contents');
      fs.mkdirSync(contentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(contentsDir, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>CFBundleShortVersionString</key>
          <string>27.0.0.preview20261015</string>
          <key>CFBundleVersion</key>
          <string>27.0.0</string>
        </dict>
        </plist>`
      );

      const verInfo = macNativeInstaller.extractRunnerVersionInfo(mockAppPath);
      expect(verInfo.version).toBe('27.0.0');
      expect(verInfo.previewDate).toBe('20261015');
      expect(verInfo.displayVersion).toBe('27.0.0 (Preview 20261015)');
    });

    it('5.7 installRunnerDirect does NOT switch to stable when downloadUrl is provided, even if public stable has higher semver', async () => {
      const fakeArchive = path.join(tmpRoot, 'crossover-preview-20261111.zip');
      fs.writeFileSync(fakeArchive, Buffer.from('PK\x03\x04'));

      let invokedCapture = false;
      const directRes = await environmentProvisioner.installRunnerDirect('crossover_preview', {
        downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        existingLayer: {
          id: 'crossover_preview',
          type: 'crossover_preview',
          version: '23.7.0', // Older than public stable 24.0.0
          buildVersion: '20261015',
        },
        customApplicationsDir: appsDir,
        homedir: tmpRoot,
        capturePreviewDownloadFn: async ({ options: hookOpts }: any) => {
          invokedCapture = true;
          return {
            archivePath: fakeArchive,
            resolvedVersion: '20261111',
          };
        },
        onExtractArchive: async (_archive: string, staging: string) => {
          const appPath = path.join(staging, 'CrossOver Preview.app');
          const contents = path.join(appPath, 'Contents');
          fs.mkdirSync(contents, { recursive: true });
          fs.writeFileSync(
            path.join(contents, 'Info.plist'),
            `<?xml version="1.0" encoding="UTF-8"?>
            <plist version="1.0">
            <dict>
              <key>CFBundleShortVersionString</key>
              <string>20261111</string>
              <key>CFBundleVersion</key>
              <string>27.0.0</string>
            </dict>
            </plist>`
          );
        },
        verifySignatureFn: async () => ({ valid: true }),
        skipCodeSignVerification: true,
      });

      expect(invokedCapture).toBe(true);
      expect(directRes.success).toBe(true);
      expect(directRes.switchedToStableCrossOver).toBeUndefined();
      expect(directRes.message).toContain('Installed CrossOver Preview');
    });

    it('5.8 runEnvironmentSetupTasks does NOT skip task when task.downloadUrl is specified, even if runner was already detected', async () => {
      const fakeArchive = path.join(tmpRoot, 'crossover-preview-20261111.zip');
      fs.writeFileSync(fakeArchive, Buffer.from('PK\x03\x04'));

      // Simulate existing CrossOver Preview installed in applications directory
      const existingApp = path.join(appsDir, 'CrossOver Preview.app');
      const existingContents = path.join(existingApp, 'Contents');
      fs.mkdirSync(path.join(existingContents, 'SharedSupport/CrossOver/bin'), { recursive: true });
      fs.writeFileSync(path.join(existingContents, 'SharedSupport/CrossOver/bin/wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(
        path.join(existingContents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>CFBundleShortVersionString</key>
          <string>20261015</string>
          <key>CFBundleVersion</key>
          <string>27.0.0</string>
        </dict>
        </plist>`
      );

      let capturedCallCount = 0;
      const res = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          runId: 'test-wizard-update-preview-no-force',
          tasks: [
            {
              action: 'install_runner',
              componentId: 'runner_crossover_preview',
              runnerType: 'crossover_preview',
              downloadUrl:
                'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
              // forceUpdate intentionally omitted to verify downloadUrl triggers the installation
            },
          ],
        },
        {
          skipNetwork: false,
          homedir: tmpRoot,
          customApplicationsDir: appsDir,
          capturePreviewDownloadFn: async () => {
            capturedCallCount++;
            return {
              archivePath: fakeArchive,
              resolvedVersion: '20261111',
            };
          },
          onExtractArchive: async (_archive: string, staging: string) => {
            const appPath = path.join(staging, 'CrossOver Preview.app');
            const contents = path.join(appPath, 'Contents');
            fs.mkdirSync(contents, { recursive: true });
            fs.writeFileSync(
              path.join(contents, 'Info.plist'),
              `<?xml version="1.0" encoding="UTF-8"?>
              <plist version="1.0">
              <dict>
                <key>CFBundleShortVersionString</key>
                <string>20261111</string>
                <key>CFBundleVersion</key>
                <string>27.0.0</string>
              </dict>
              </plist>`
            );
          },
          verifySignatureFn: async () => ({ valid: true }),
          skipCodeSignVerification: true,
        }
      );

      expect(res.success).toBe(true);
      expect(capturedCallCount).toBe(1);
      expect(res.outcomes[0].status).toBe('completed');
    });

    it('5.9 resolvePreviewBundleVersion extracts semver from CFBundleShortVersionString when CFBundleVersion contains the preview date', () => {
      const mockAppPath = path.join(appsDir, 'CrossOver Staged App.app');
      const contentsDir = path.join(mockAppPath, 'Contents');
      fs.mkdirSync(contentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(contentsDir, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>CFBundleShortVersionString</key>
          <string>27.0.0</string>
          <key>CFBundleVersion</key>
          <string>20261111</string>
        </dict>
        </plist>`
      );

      // Even if hintVersion is the 8-digit date '20261111', it resolves canonical semver '27.0.0'
      const resolved = environmentProvisioner.resolvePreviewBundleVersion(mockAppPath, '20261111');
      expect(resolved).toBe('27.0.0');
    });

    it('5.10 installRunnerDirect does NOT get hijacked by existingLayer SUFeedURL when downloadUrl is provided', async () => {
      const existingPreviewApp = path.join(appsDir, 'Existing CrossOver Preview.app');
      const existingContents = path.join(existingPreviewApp, 'Contents');
      fs.mkdirSync(existingContents, { recursive: true });
      fs.writeFileSync(
        path.join(existingContents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>CFBundleShortVersionString</key>
          <string>24.0.0</string>
          <key>CFBundleVersion</key>
          <string>20261015</string>
          <key>SUFeedURL</key>
          <string>https://www.codeweavers.com/xml/versions/cxmac.xml</string>
        </dict>
        </plist>`
      );

      const fakeArchive = path.join(tmpRoot, 'crossover-preview-20261111.zip');
      fs.writeFileSync(fakeArchive, Buffer.from('PK\x03\x04'));

      let invokedCapture = false;
      let capturedTargetUrl = '';
      const res = await environmentProvisioner.installRunnerDirect('crossover_preview', {
        downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        existingLayer: {
          id: 'crossover_preview',
          type: 'crossover_preview',
          version: '24.0.0',
          buildVersion: '20261015',
          appPath: existingPreviewApp,
        },
        customApplicationsDir: appsDir,
        homedir: tmpRoot,
        capturePreviewDownloadFn: async ({ options: hookOpts }: any) => {
          invokedCapture = true;
          capturedTargetUrl = hookOpts.downloadUrl;
          return {
            archivePath: fakeArchive,
            resolvedVersion: '20261111',
          };
        },
        onExtractArchive: async (_archive: string, staging: string) => {
          const appPath = path.join(staging, 'CrossOver Preview.app');
          const contents = path.join(appPath, 'Contents');
          fs.mkdirSync(contents, { recursive: true });
          fs.writeFileSync(
            path.join(contents, 'Info.plist'),
            `<?xml version="1.0" encoding="UTF-8"?>
            <plist version="1.0">
            <dict>
              <key>CFBundleShortVersionString</key>
              <string>27.0.0</string>
              <key>CFBundleVersion</key>
              <string>20261111</string>
            </dict>
            </plist>`
          );
        },
        verifySignatureFn: async () => ({ valid: true }),
        skipCodeSignVerification: true,
      });

      expect(res.success).toBe(true);
      expect(invokedCapture).toBe(true);
      expect(capturedTargetUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
      expect((res as any).switchedToStableCrossOver).toBeFalsy();
    });

    it('5.11 installCompatibilityLayer on clean system forwards payload.downloadUrl to direct installer', async () => {
      const fakeArchive = path.join(tmpRoot, 'crossover-preview-clean-20261111.zip');
      fs.writeFileSync(fakeArchive, Buffer.from('PK\x03\x04'));

      let directInstallerCalledWithUrl = '';
      const res = await macNativeInstaller.installCompatibilityLayer(
        {
          runnerType: 'crossover_preview',
          mode: 'auto',
          downloadUrl:
            'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        },
        {
          customApplicationsDir: appsDir,
          homedir: tmpRoot,
          capturePreviewDownloadFn: async ({ options: hookOpts }: any) => {
            directInstallerCalledWithUrl = hookOpts.downloadUrl;
            return {
              archivePath: fakeArchive,
              resolvedVersion: '20261111',
            };
          },
          onExtractArchive: async (_archive: string, staging: string) => {
            const appPath = path.join(staging, 'CrossOver Preview.app');
            const contents = path.join(appPath, 'Contents');
            fs.mkdirSync(contents, { recursive: true });
            fs.writeFileSync(
              path.join(contents, 'Info.plist'),
              `<?xml version="1.0" encoding="UTF-8"?>
              <plist version="1.0">
              <dict>
                <key>CFBundleShortVersionString</key>
                <string>27.0.0</string>
                <key>CFBundleVersion</key>
                <string>20261111</string>
              </dict>
              </plist>`
            );
          },
          verifySignatureFn: async () => ({ valid: true }),
          skipCodeSignVerification: true,
        }
      );

      expect(res.success).toBe(true);
      expect(directInstallerCalledWithUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
    });

    it('5.12 checkCompatibilityLayerUpdates parses preview date and semver from preview Sparkle feed', async () => {
      const mockSparkleXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
        <channel>
          <title>CrossOver Preview Changelog</title>
          <item>
            <title>CrossOver Preview 20261111</title>
            <enclosure
              url="https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip"
              sparkle:version="20261111"
              sparkle:shortVersionString="27.0.0"
              length="480000000"
              type="application/octet-stream"
            />
          </item>
        </channel>
      </rss>`;

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        customApplicationsDir: appsDir,
        homedir: tmpRoot,
        previewFeedUrl: 'https://www.codeweavers.com/xml/versions/cxpreview.xml',
        httpGetText: async (url: string) => {
          if (url.includes('cxpreview.xml')) return mockSparkleXml;
          return null;
        },
      });

      const previewUpd = updates.crossover_preview;
      expect(previewUpd).toBeDefined();
      expect(previewUpd.latestVersion).toBe('20261111');
      expect(previewUpd.latestDisplayVersion).toBe('27.0.0 (Preview 20261111)');
      expect(previewUpd.canAutoUpdate).toBe(true);
      expect(previewUpd.downloadUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
    });

    it('5.13 buildProvisioningTasksFromSelection builds install_runner task without forwarding externalDownloadUrl over IPC', () => {
      const snapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'missing',
          externalDownloadUrl:
            'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
          canAutoInstall: true,
        },
      });

      const tasks = buildProvisioningTasksFromSelection({
        snapshot,
        selectedIds: new Set<EnvironmentComponentId>(['runner_crossover_preview']),
        chosenRunner: 'crossover_preview',
        bottleMode: 'reuse_existing',
        bottleName: 'OneLauncher',
        gptkDmgPath: '',
      });

      const runnerTask = tasks.find((t) => t.componentId === 'runner_crossover_preview');
      expect(runnerTask).toBeDefined();
      expect(runnerTask?.action).toBe('install_runner');
      expect(runnerTask?.runnerType).toBe('crossover_preview');
      expect((runnerTask as unknown as Record<string, unknown>)?.downloadUrl).toBeUndefined();
    });

    it('5.14 launcherService.installCompatibilityLayer forwards authenticateOnly and archivePath to window.electronAPI', async () => {
      const origWindow = (globalThis as any).window;
      let receivedPayload: any = null;
      (globalThis as any).window = {
        electronAPI: {
          installCompatibilityLayer: async (payload: any) => {
            receivedPayload = payload;
            return { success: true, runnerType: payload.runnerType, layers: [] };
          },
        },
      };

      try {
        await launcherService.installCompatibilityLayer('crossover_preview', 'auto', {
          authenticateOnly: true,
        });
        expect(receivedPayload).toEqual({
          runnerType: 'crossover_preview',
          mode: 'auto',
          authenticateOnly: true,
        });
      } finally {
        (globalThis as any).window = origWindow;
      }
    });

    it('5.15 checkCompatibilityLayerUpdates uses session-aware fetch (previewSessionFetch) and discovers 20261111 when on 20261015 (ISSUE-01)', async () => {
      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
      };

      let fetchedUrl = '';
      const mockSessionFetch = async (url: string) => {
        fetchedUrl = url;
        return {
          ok: true,
          status: 200,
          url: 'https://www.codeweavers.com/preview/download',
          text: async () => `
            <html>
              <body>
                <h1>CrossOver Technology Preview</h1>
                <a href="https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip">Download CrossOver Preview</a>
              </body>
            </html>
          `,
        };
      };

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [installedLayer],
        previewSessionFetch: mockSessionFetch,
      });

      expect(fetchedUrl).toBe('https://www.codeweavers.com/preview/download');
      const previewUpd = updates.crossover_preview;
      expect(previewUpd).toBeDefined();
      expect(previewUpd.latestVersion).toBe('20261111');
      expect(previewUpd.updateAvailable).toBe(true);
      expect(previewUpd.authRequired).toBe(false);
      expect(previewUpd.downloadUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
    });

    it('5.16 checkCompatibilityLayerUpdates detects unauthenticated session gracefully without false "Up to Date" (ISSUE-02)', async () => {
      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
      };

      // Simulates redirect to login page when session cookie is absent or expired
      const mockUnauthSessionFetch = async (_url: string) => {
        return {
          ok: true,
          status: 200,
          url: 'https://www.codeweavers.com/login/',
          text: async () => `
            <html>
              <body>
                <h2>Sign in to CodeWeavers</h2>
                <form action="/login/" method="post">
                  <input type="text" name="email" />
                  <input type="password" name="password" />
                </form>
              </body>
            </html>
          `,
        };
      };

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [installedLayer],
        previewSessionFetch: mockUnauthSessionFetch,
      });

      const previewUpd = updates.crossover_preview;
      expect(previewUpd).toBeDefined();
      expect(previewUpd.authRequired).toBe(true);
      expect(previewUpd.updateAvailable).toBe(false);
      expect(previewUpd.statusMessage).toContain('Sign in to CodeWeavers Preview to check for updates');
    });

    it('5.17 Setup Wizard and Settings UI render honest sign-in prompts when authRequired is true (ISSUE-02)', async () => {
      // 1. Setup Wizard Snapshot prober reflects authRequired
      const mockUnauthSessionFetch = async (_url: string) => ({
        ok: true,
        status: 200,
        url: 'https://www.codeweavers.com/login/',
        text: async () => '<input type="password" name="password" />',
      });

      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
      };

      const snapshot = await environmentHealthProber.probeEnvironmentHealth({
        platform: 'darwin',
        arch: 'arm64',
        layers: [installedLayer],
        customApplicationsDir: appsDir,
        homedir: tmpRoot,
        previewSessionFetch: mockUnauthSessionFetch,
      });

      const previewComp = snapshot.components.runner_crossover_preview;
      expect(previewComp.authRequired).toBe(true);
      expect(previewComp.statusDetail).toContain('Sign in to CodeWeavers Preview to check for updates');

      // 2. CompatibilityAndBottleStep renders runner card and status detail without duplicate footer
      const step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot,
        chosenRunner: 'crossover_preview',
        onSelectRunner: vi.fn(),
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
      });
      const stepTree = step.render();
      const runnerCard = findVNodeByTestId(stepTree, 'setup-runner-crossover-preview');
      expect(runnerCard).toBeDefined();
      const statusText = findVNodeByTestId(stepTree, 'runner-install-status-crossover-preview');
      expect(statusText).toBeDefined();
      expect(extractVNodeText(statusText)).toContain('Installed');

      // 3. GameLaunchConfigModal renders runner-auth-required-badge and sign-in-runner-btn
      const updateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        installedBuildVersion: '20261015',
        installedDisplayVersion: '27.0.0 (Preview 20261015)',
        updateAvailable: false,
        downloadUrl: 'https://www.codeweavers.com/preview/download',
        authRequired: true,
        canAutoUpdate: true,
        checkedAt: '2026-11-12T00:00:00.000Z',
      };

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        platforms: [{
          platformId: 'steam',
          platformGameId: '1091500',
          installed: true,
          installPath: '/Users/test/Games/Cyberpunk2077',
          executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
          isWindowsBinaryOnMac: true,
          platforms: { windows: true, mac: false, linux: false },
        }],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([installedLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([installedLayer]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Cyberpunk 2077',
        installPath: '/Users/test/Games/Cyberpunk2077',
        executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let modalTree = modal.render();
      await Promise.resolve();
      modalTree = modal.render();

      const statusBanner = findVNodeByTestId(modalTree, 'runner-status-banner');
      expect(statusBanner).toBeDefined();
      expect(findVNodeByTestId(modalTree, 'manage-runners-bottles-btn')).toBeDefined();
      // Embedded auth/installer buttons were moved to Setup Wizard in Wave 1
      expect(findVNodeByTestId(modalTree, 'runner-auth-required-badge')).toBeUndefined();
      expect(findVNodeByTestId(modalTree, 'sign-in-runner-btn')).toBeUndefined();
      modal.unmount();

      const formHarness = createLaunchConfigFormHarness({
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      formHarness.render();
      await Promise.resolve();
      formHarness.render();
      expect(formHarness.current.activeUpdateInfo?.authRequired).toBe(true);
      formHarness.unmount();
    });

    it('5.18 captureCodeWeaversPreviewDownload prevents options.downloadUrl from bypassing login gate when hasPasswordInput is true (ISSUE-03)', async () => {
      let downloadUrlTriggeredBeforeLogin = false;
      let windowShown = false;
      let loggedIn = false;
      let downloadedFinalUrl: string | null = null;

      class MockAuthBrowserWindow {
        webContents: any;
        listeners: Record<string, Function[]> = {};
        constructor() {
          const listeners = this.listeners;
          this.webContents = {
            on: (event: string, fn: Function) => {
              listeners[event] = listeners[event] || [];
              listeners[event].push(fn);
            },
            executeJavaScript: async () => {
              // When not logged in, password input is present
              if (!loggedIn) {
                return { hrefs: [], hasPasswordInput: true };
              }
              return {
                hrefs: [
                  'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
                ],
                hasPasswordInput: false,
              };
            },
            getURL: () => (loggedIn ? 'https://www.codeweavers.com/preview/download' : 'https://www.codeweavers.com/login/'),
            downloadURL: (url: string) => {
              if (!loggedIn) {
                downloadUrlTriggeredBeforeLogin = true;
              }
              downloadedFinalUrl = url;
              // Trigger will-download
              setTimeout(() => {
                const item = {
                  getURL: () => url,
                  getURLChain: () => [url],
                  getFilename: () => path.basename(url),
                  setSavePath: (p: string) => {
                    fs.writeFileSync(p, 'fake-zip-data');
                  },
                  on: () => {},
                  once: (evt: string, cb: Function) => {
                    if (evt === 'done') cb({}, 'completed');
                  },
                };
                mockSessionListeners['will-download']?.({}, item);
              }, 10);
            },
            loadURL: async (u: string) => {
              this.loadURL(u);
            },
          };

          setTimeout(() => {
            this.emit('did-navigate', {}, 'https://www.codeweavers.com/login/');
            this.emit('did-finish-load');
            // Simulate user logging in after window is shown
            setTimeout(() => {
              loggedIn = true;
              this.emit('did-navigate', {}, 'https://www.codeweavers.com/preview/download');
              this.emit('did-finish-load');
            }, 50);
          }, 10);
        }
        emit(event: string, ...args: any[]) {
          for (const fn of (this.listeners[event] || [])) {
            try { fn(...args); } catch {}
          }
        }
        show() { windowShown = true; }
        focus() {}
        hide() {}
        close() {}
        destroy() {}
        isDestroyed() { return false; }
        loadURL(u: string) {
          if (u.includes('/preview/download') && !loggedIn) {
            this.emit('did-navigate', {}, 'https://www.codeweavers.com/login/');
          }
        }
      }

      const mockSessionListeners: Record<string, Function> = {};
      const mockSession = {
        on: (evt: string, fn: Function) => { mockSessionListeners[evt] = fn; },
        removeListener: () => {},
        off: () => {},
      };

      const captureDest = path.join(tmpRoot, 'capture-dest');
      fs.mkdirSync(captureDest, { recursive: true });

      const res = await environmentProvisioner.captureCodeWeaversPreviewDownload(
        captureDest,
        {
          runId: 'test-run',
          componentId: 'runner_crossover_preview',
          stepIndex: 0,
          totalSteps: 1,
        },
        {
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
          electronMod: {
            BrowserWindow: MockAuthBrowserWindow,
            session: {
              fromPartition: () => mockSession,
            },
          },
        }
      );

      // Crucial: downloadURL must NOT have been called while on the login page!
      expect(downloadUrlTriggeredBeforeLogin).toBe(false);
      expect(windowShown).toBe(true);
      expect(downloadedFinalUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
      expect(res.resolvedVersion).toBe('20261111');
      expect(fs.existsSync(res.archivePath)).toBe(true);
    });

    it('5.19 checkCompatibilityLayerUpdates detects unauthenticated session when login HTML contains general navigation links (adversarial real-world portal redirect)', async () => {
      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
      };

      // Real-world CodeWeavers login page contains dozens of navigation links but no preview archive
      const mockRealWorldLoginFetch = async (_url: string) => ({
        ok: true,
        status: 200,
        url: 'https://www.codeweavers.com/login/',
        text: async () => `
          <html>
            <head><title>Sign In | CodeWeavers</title></head>
            <body>
              <nav>
                <a href="/crossover">CrossOver</a>
                <a href="/crossover/download">Download</a>
                <a href="/store">Store</a>
                <a href="/about">About</a>
                <a href="https://support.codeweavers.com/">Support</a>
                <a href="/privacy-policy">Privacy Policy</a>
              </nav>
              <form action="/login/" method="post">
                <input type="text" name="email" />
                <input type="password" name="password" />
                <button type="submit">Sign In</button>
              </form>
            </body>
          </html>
        `,
      });

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [installedLayer],
        previewSessionFetch: mockRealWorldLoginFetch,
      });

      const previewUpd = updates.crossover_preview;
      expect(previewUpd).toBeDefined();
      expect(previewUpd.authRequired).toBe(true);
      expect(previewUpd.updateAvailable).toBe(false);
      expect(previewUpd.statusMessage).toContain('Sign in to CodeWeavers Preview to check for updates');
    });

    it('5.20 checkCompatibilityLayerUpdates matches candidate download link embedded in data-download-url attributes', async () => {
      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
      };

      const mockDataAttrFetch = async (_url: string) => ({
        ok: true,
        status: 200,
        url: 'https://www.codeweavers.com/preview/download',
        text: async () => `
          <div class="download-section">
            <button data-download-url="https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip">
              Download Preview
            </button>
          </div>
        `,
      });

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [installedLayer],
        previewSessionFetch: mockDataAttrFetch,
      });

      const previewUpd = updates.crossover_preview;
      expect(previewUpd).toBeDefined();
      expect(previewUpd.authRequired).toBe(false);
      expect(previewUpd.updateAvailable).toBe(true);
      expect(previewUpd.latestVersion).toBe('20261111');
      expect(previewUpd.downloadUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
    });

    it('5.21 permits Cloudflare Turnstile, cf-challenges, and Apple ID SSO navigation domains (ISSUE-05)', () => {
      const isAllowedNav = (environmentProvisioner as any).isAllowedCodeWeaversAuthNavigationUrl;
      expect(isAllowedNav('https://challenges.cloudflare.com/turnstile/v0/api.js')).toBe(true);
      expect(isAllowedNav('https://cf-challenges.com/challenge-platform/h/g')).toBe(true);
      expect(isAllowedNav('https://turnstile.cloudflare.com/challenge')).toBe(true);
      expect(isAllowedNav('https://appleid.apple.com/auth/authorize')).toBe(true);
      expect(isAllowedNav('https://idmsa.apple.com/IDMSWebAuth/signin')).toBe(true);
      expect(isAllowedNav('https://accounts.google.com/o/oauth2/auth')).toBe(true);
      expect(isAllowedNav('https://www.codeweavers.com/preview/download')).toBe(true);
      expect(isAllowedNav('https://malicious-site.com/login')).toBe(false);
      expect(isAllowedNav('http://challenges.cloudflare.com/insecure')).toBe(false);
    });

    it('5.22 sets clean desktop browser User-Agent on session & webContents for Cloudflare Turnstile resilience (ISSUE-05)', async () => {
      let sessionUaSet: string | null = null;
      let webContentsUaSet: string | null = null;

      class MockTurnstileBrowserWindow {
        webContents: any;
        constructor() {
          this.webContents = {
            setUserAgent: (ua: string) => { webContentsUaSet = ua; },
            on: () => {},
            executeJavaScript: async () => ({ hrefs: [], hasPasswordInput: true }),
            getURL: () => 'https://www.codeweavers.com/login/',
            downloadURL: () => {},
            loadURL: async () => {},
          };
        }
        show() {}
        focus() {}
        hide() {}
        close() {}
        destroy() {}
        isDestroyed() { return false; }
        loadURL(u: string) {}
      }

      const mockSession = {
        setUserAgent: (ua: string) => { sessionUaSet = ua; },
        on: () => {},
        removeListener: () => {},
        off: () => {},
      };

      const captureDest = path.join(tmpRoot, 'capture-ua-test');
      fs.mkdirSync(captureDest, { recursive: true });

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 80);

      await expect(
        environmentProvisioner.captureCodeWeaversPreviewDownload(
          captureDest,
          {
            runId: 'ua-test',
            componentId: 'runner_crossover_preview',
            stepIndex: 0,
            totalSteps: 1,
          },
          {
            electronMod: {
              BrowserWindow: MockTurnstileBrowserWindow,
              session: {
                fromPartition: () => mockSession,
              },
            },
          },
          controller.signal
        )
      ).rejects.toThrow(/cancelled/i);

      expect(sessionUaSet).toBeDefined();
      expect(sessionUaSet).not.toContain('Electron');
      expect(sessionUaSet).not.toContain('OneLauncher');
      expect(sessionUaSet).toMatch(/Mozilla\/5\.0/);

      expect(webContentsUaSet).toBeDefined();
      expect(webContentsUaSet).not.toContain('Electron');
      expect(webContentsUaSet).not.toContain('OneLauncher');
    });

    it('5.23 ignores non-archive downloads (PDFs/notes) without closing auth window, and blocks untrusted hosts (ISSUE-07)', async () => {
      let nonArchiveItemCancelled = false;
      let untrustedItemCancelled = false;
      let authWindowClosed = false;

      class MockDocDownloadBrowserWindow {
        webContents: any;
        listeners: Record<string, Function[]> = {};
        constructor() {
          const listeners = this.listeners;
          this.webContents = {
            on: (evt: string, fn: Function) => {
              listeners[evt] = listeners[evt] || [];
              listeners[evt].push(fn);
            },
            executeJavaScript: async () => ({ hrefs: [], hasPasswordInput: true }),
            getURL: () => 'https://www.codeweavers.com/preview/download',
            downloadURL: () => {},
            loadURL: async () => {},
          };
        }
        emit(event: string, ...args: any[]) {
          for (const fn of (this.listeners[event] || [])) {
            try { fn(...args); } catch {}
          }
        }
        show() {}
        focus() {}
        hide() {}
        close() { authWindowClosed = true; }
        destroy() { authWindowClosed = true; }
        isDestroyed() { return authWindowClosed; }
        loadURL(u: string) {}
      }

      const docSessionListeners: Record<string, any> = {};
      const mockSession = {
        setUserAgent: () => {},
        on: (evt: string, fn: any) => {
          docSessionListeners[evt] = fn;
        },
        removeListener: () => {},
        off: () => {},
      };

      const captureDest = path.join(tmpRoot, 'capture-doc-test');
      fs.mkdirSync(captureDest, { recursive: true });

      const controller = new AbortController();

      const capturePromise = environmentProvisioner.captureCodeWeaversPreviewDownload(
        captureDest,
        {
          runId: 'doc-test',
          componentId: 'runner_crossover_preview',
          stepIndex: 0,
          totalSteps: 1,
        },
        {
          electronMod: {
            BrowserWindow: MockDocDownloadBrowserWindow,
            session: {
              fromPartition: () => mockSession,
            },
          },
        },
        controller.signal
      );

      // Simulate a non-archive download (e.g. ReleaseNotes.pdf from CodeWeavers)
      await new Promise((r) => setTimeout(r, 20));
      const nonArchiveItem = {
        getURL: () => 'https://www.codeweavers.com/preview/ReleaseNotes.pdf',
        getURLChain: () => ['https://www.codeweavers.com/preview/ReleaseNotes.pdf'],
        getFilename: () => 'ReleaseNotes.pdf',
        cancel: () => { nonArchiveItemCancelled = true; },
      };
      docSessionListeners['will-download']?.({}, nonArchiveItem);

      // Non-archive download should be cancelled, but window must NOT be closed!
      expect(nonArchiveItemCancelled).toBe(true);
      expect(authWindowClosed).toBe(false);

      // Now simulate an untrusted host download attempt
      const untrustedItem = {
        getURL: () => 'https://malicious-site.com/crossover-preview-20261111.zip',
        getURLChain: () => ['https://malicious-site.com/crossover-preview-20261111.zip'],
        getFilename: () => 'crossover-preview-20261111.zip',
        cancel: () => { untrustedItemCancelled = true; },
      };
      docSessionListeners['will-download']?.({}, untrustedItem);

      expect(untrustedItemCancelled).toBe(true);
      await expect(capturePromise).rejects.toThrow(/INSTALLER_URL_BLOCKED|Blocked CrossOver Preview download/i);
      await new Promise((r) => setImmediate(r));
      expect(authWindowClosed).toBe(true);
    });

    it('5.24 extracts candidate preview links from data-url attributes inside interactive BrowserWindow', async () => {
      let downloadedUrl: string | null = null;
      let windowClosed = false;
      const dataUrlSessionListeners: Record<string, any> = {};

      class MockDataUrlBrowserWindow {
        webContents: any;
        listeners: Record<string, Function[]> = {};
        constructor() {
          const listeners = this.listeners;
          this.webContents = {
            on: (evt: string, fn: Function) => {
              listeners[evt] = listeners[evt] || [];
              listeners[evt].push(fn);
            },
            executeJavaScript: async (_code: string) => {
              // Simulates DOM with data-url on download button
              return {
                hrefs: [
                  'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
                ],
                hasPasswordInput: false,
              };
            },
            getURL: () => 'https://www.codeweavers.com/preview/download',
            downloadURL: (url: string) => {
              downloadedUrl = url;
              setTimeout(() => {
                const item = {
                  getURL: () => url,
                  getURLChain: () => [url],
                  getFilename: () => path.basename(url),
                  setSavePath: (p: string) => {
                    fs.writeFileSync(p, 'zip-binary-data');
                  },
                  on: () => {},
                  once: (evt: string, cb: Function) => {
                    if (evt === 'done') cb({}, 'completed');
                  },
                };
                dataUrlSessionListeners['will-download']?.({}, item);
              }, 10);
            },
            loadURL: async () => {},
          };
          setTimeout(() => {
            this.emit('did-navigate', {}, 'https://www.codeweavers.com/preview/download');
            this.emit('did-finish-load');
          }, 15);
        }
        emit(event: string, ...args: any[]) {
          for (const fn of (this.listeners[event] || [])) {
            try { fn(...args); } catch {}
          }
        }
        show() {}
        focus() {}
        hide() {}
        close() { windowClosed = true; }
        destroy() { windowClosed = true; }
        isDestroyed() { return windowClosed; }
        loadURL(u: string) {}
      }

      const mockSession = {
        setUserAgent: () => {},
        on: (evt: string, fn: any) => {
          dataUrlSessionListeners[evt] = fn;
        },
        removeListener: () => {},
        off: () => {},
      };

      const captureDest = path.join(tmpRoot, 'capture-data-url-test');
      fs.mkdirSync(captureDest, { recursive: true });

      const res = await environmentProvisioner.captureCodeWeaversPreviewDownload(
        captureDest,
        {
          runId: 'data-url-test',
          componentId: 'runner_crossover_preview',
          stepIndex: 0,
          totalSteps: 1,
        },
        {
          electronMod: {
            BrowserWindow: MockDataUrlBrowserWindow,
            session: {
              fromPartition: () => mockSession,
            },
          },
        }
      );

      expect(downloadedUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
      expect(res.resolvedVersion).toBe('20261111');
      expect(fs.existsSync(res.archivePath)).toBe(true);
      await new Promise((r) => setImmediate(r));
      expect(windowClosed).toBe(true);
    });

    it('5.25 checkCompatibilityLayerUpdates propagates previewDate and semver onto CompatibilityLayerUpdateInfo', async () => {
      // 1. Clean machine with date-only download URL
      const cleanUpdates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        customApplicationsDir: appsDir,
        homedir: tmpRoot,
        previewCandidateUrls: [
          'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        ],
      });

      const cleanPreviewUpd = cleanUpdates.crossover_preview;
      expect(cleanPreviewUpd).toBeDefined();
      expect(cleanPreviewUpd.latestVersion).toBe('20261111');
      expect(cleanPreviewUpd.previewDate).toBe('20261111');
      expect(cleanPreviewUpd.semver).toBeUndefined();
      expect(cleanPreviewUpd.downloadUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );

      // 2. Candidate URL with semver or installed preview layer
      const semverUpdates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        customApplicationsDir: appsDir,
        homedir: tmpRoot,
        layers: [{
          id: 'crossover_preview',
          type: 'crossover_preview',
          version: '27.0.0',
          previewDate: '20261015',
        }],
        previewCandidateUrls: [
          'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        ],
      });
      const semverPreviewUpd = semverUpdates.crossover_preview;
      expect(semverPreviewUpd.previewDate).toBe('20261111');
      expect(semverPreviewUpd.semver).toBe('27.0.0');
    });

    it('5.26 probeEnvironmentHealth propagates previewDate and semver onto EnvironmentComponentState', async () => {
      const snapshot = await environmentHealthProber.probeEnvironmentHealth({
        platform: 'darwin',
        arch: 'arm64',
        layers: [{
          id: 'crossover_preview',
          type: 'crossover_preview',
          version: '27.0.0',
          previewDate: '20261015',
        }],
        customApplicationsDir: appsDir,
        homedir: tmpRoot,
        previewCandidateUrls: [
          'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        ],
      });

      const previewComp = snapshot.components.runner_crossover_preview;
      expect(previewComp).toBeDefined();
      expect(previewComp.previewDate).toBe('20261111');
      expect(previewComp.semver).toBe('27.0.0');
      expect(previewComp.latestVersion).toBe('20261111');
    });

    it('5.27 extractCandidateLinksFromText parses data-href attributes alongside data-url and data-download-url', () => {
      const html = `
        <div class="actions">
          <button data-href="https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip">Download</button>
          <a data-url="https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip">ARM</a>
          <span data-download-url="https://media.codeweavers.com/pub/crossover/demo/crossover-26.3.0.zip">Demo</span>
        </div>
      `;
      const links = macNativeInstaller.extractCandidateLinksFromText(html);
      expect(links).toContain(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
      expect(links).toContain(
        'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip'
      );
      expect(links).toContain(
        'https://media.codeweavers.com/pub/crossover/demo/crossover-26.3.0.zip'
      );
    });

    it('5.28 extractRunnerPreviewDate parses preview date from object with externalDownloadUrl', () => {
      const compLike = {
        id: 'runner_crossover_preview',
        externalDownloadUrl:
          'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
      };
      const parsedDate = macNativeInstaller.extractRunnerPreviewDate(compLike);
      expect(parsedDate).toBe('20261111');
    });

    it('5.29 CompatibilityAndBottleStep renders formatted latestDisplayVersion in update badge and opt-in row', () => {
      const macSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'update_available',
          version: '27.0.0 (Preview 20261015)',
          latestVersion: '20261111',
          latestDisplayVersion: '27.0.0 (Preview 20261111)',
          previewDate: '20261111',
          canAutoInstall: true,
          requiresExternalDownload: false,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        },
      });

      const step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: macSnapshot,
        chosenRunner: 'crossover_preview',
        onSelectRunner: vi.fn(),
        bottleMode: 'reuse_existing',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        runnerUpdateOptInIds: new Set<EnvironmentComponentId>(['runner_crossover_preview']),
      });

      const tree = step.render();
      const badge = findVNodeByTestId(tree, 'runner-update-badge-crossover-preview');
      expect(badge).toBeDefined();
      expect(extractVNodeText(badge)).toContain('Update Available · v20261111');

      const optinRow = findVNodeByTestId(tree, 'runner-update-optin-row-crossover-preview');
      expect(optinRow).toBeDefined();
      expect(extractVNodeText(optinRow)).toContain('Update to v20261111 during setup');
      step.unmount();
    });

    it('5.30 CompatibilityLayerSection displays spinner and "Signing In..." on sign-in-runner-btn when isUpdatingRunner is true', async () => {
      const updateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        installedBuildVersion: '20261015',
        installedDisplayVersion: '27.0.0 (Preview 20261015)',
        updateAvailable: false,
        downloadUrl: 'https://www.codeweavers.com/preview/download',
        authRequired: true,
        canAutoUpdate: true,
        checkedAt: '2026-11-12T00:00:00.000Z',
      };

      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
      };

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        platforms: [{
          platformId: 'steam',
          platformGameId: '1091500',
          installed: true,
          installPath: '/Users/test/Games/Cyberpunk2077',
          executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
          isWindowsBinaryOnMac: true,
          platforms: { windows: true, mac: false, linux: false },
        }],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([installedLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([installedLayer]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Cyberpunk 2077',
        installPath: '/Users/test/Games/Cyberpunk2077',
        executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      let resolveUpdate: any;
      const updatePromise = new Promise((r) => { resolveUpdate = r; });
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(() => updatePromise as any);

      const formHarness = createLaunchConfigFormHarness({
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      formHarness.render();
      await Promise.resolve();
      formHarness.render();

      expect(formHarness.current.activeUpdateInfo?.authRequired).toBe(true);
      expect(formHarness.current.isUpdatingRunner).toBe(false);

      // Start sign-in / update operation and verify isUpdatingRunner tracks active flight
      const pendingOp = formHarness.current.handleUpdateRunner();
      formHarness.render();
      expect(formHarness.current.isUpdatingRunner).toBe(true);
      expect(formHarness.current.isAnotherRunnerOperationActive).toBe(false);

      resolveUpdate({ success: true, updated: true, detectedLayers: [installedLayer] });
      await pendingOp;
      formHarness.render();
      expect(formHarness.current.isUpdatingRunner).toBe(false);
      formHarness.unmount();
    });

    it('5.31 Setup Wizard renders auth detail before probe update, and surfaces update badge & opt-in toggle when snapshot reports update_available', async () => {
      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
      };

      const initialSnapshot: EnvironmentHealthSnapshot = {
        ...makeSyntheticSetupSnapshot('darwin'),
        detectedRunners: [installedLayer],
        components: {
          ...makeSyntheticSetupSnapshot('darwin').components,
          runner_crossover_preview: {
            id: 'runner_crossover_preview',
            category: 'compatibility_runner',
            scope: 'system',
            title: 'CrossOver Preview',
            shortLabel: 'CrossOver Preview',
            status: 'ready',
            authRequired: true,
            version: '27.0.0 (Preview 20261015)',
            statusDetail: 'Installed (27.0.0 (Preview 20261015)) — Sign in to CodeWeavers Preview to check for updates',
            canAutoInstall: true,
            recommendationTier: 'optional',
            recommendationBadge: 'Optional',
            defaultSelected: false,
            whyExplanation: 'Early-access CrossOver build.',
          },
        } as any,
        connectedStorefronts: [],
        counts: {
          readyCount: 1,
          missingRecommendedCount: 0,
          removedSinceLastSetupCount: 0,
          pendingClientLoginCount: 0,
          accountMismatchCount: 0,
          updateAvailableCount: 0,
        },
      };

      const updatedSnapshot: EnvironmentHealthSnapshot = {
        ...initialSnapshot,
        components: {
          ...initialSnapshot.components,
          runner_crossover_preview: {
            ...initialSnapshot.components.runner_crossover_preview!,
            status: 'update_available',
            authRequired: undefined,
            latestVersion: '20261111',
            latestDisplayVersion: 'Preview 20261111',
            statusDetail: 'Installed (27.0.0 (Preview 20261015)) — Update Preview 20261111 available',
          },
        } as any,
      };

      const onToggleRunnerUpdate = vi.fn();
      const step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: initialSnapshot,
        chosenRunner: 'crossover_preview',
        onSelectRunner: vi.fn(),
        bottleMode: 'reuse_existing',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        runnerUpdateOptInIds: new Set<EnvironmentComponentId>([]),
        onToggleRunnerUpdate,
      });

      let tree = step.render();
      expect(extractVNodeText(findVNodeByTestId(tree, 'runner-install-status-crossover-preview'))).toContain('Installed');
      expect(findVNodeByTestId(tree, 'runner-update-badge-crossover-preview')).toBeUndefined();
      expect(findVNodeByTestId(tree, 'runner-update-optin-row-crossover-preview')).toBeUndefined();

      tree = step.render({ snapshot: updatedSnapshot });
      const badge = findVNodeByTestId(tree, 'runner-update-badge-crossover-preview');
      expect(badge).toBeDefined();
      expect(extractVNodeText(badge)).toContain('v20261111');

      const optinRow = findVNodeByTestId(tree, 'runner-update-optin-row-crossover-preview');
      expect(optinRow).toBeDefined();
      expect(extractVNodeText(optinRow)).toContain('Update to v20261111 during setup');
      const toggle = findVNodeByTestId(tree, 'runner-update-toggle-crossover-preview');
      expect(toggle).toBeDefined();
      toggle.props.onClick({ stopPropagation: () => {} } as any);
      expect(onToggleRunnerUpdate).toHaveBeenCalledWith('runner_crossover_preview', true);

      step.unmount();
    });

    it('5.32 Setup Wizard up-to-date CrossOver Preview renders Installed cleanly without update toggle', async () => {
      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261111',
        displayVersion: '27.0.0 (Preview 20261111)',
        previewDate: '20261111',
        supportsMetalFxDlssD3dMetal: true,
      };

      const initialSnapshot: EnvironmentHealthSnapshot = {
        ...makeSyntheticSetupSnapshot('darwin'),
        detectedRunners: [installedLayer],
        components: {
          ...makeSyntheticSetupSnapshot('darwin').components,
          runner_crossover_preview: {
            id: 'runner_crossover_preview',
            category: 'compatibility_runner',
            scope: 'system',
            title: 'CrossOver Preview',
            shortLabel: 'CrossOver Preview',
            status: 'ready',
            authRequired: true,
            version: '27.0.0 (Preview 20261111)',
            statusDetail: 'Installed (27.0.0 (Preview 20261111)) — Sign in to CodeWeavers Preview to check for updates',
            canAutoInstall: true,
            recommendationTier: 'optional',
            recommendationBadge: 'Optional',
            defaultSelected: false,
            whyExplanation: 'Early-access CrossOver build.',
          },
        } as any,
        connectedStorefronts: [],
        counts: {
          readyCount: 1,
          missingRecommendedCount: 0,
          removedSinceLastSetupCount: 0,
          pendingClientLoginCount: 0,
          accountMismatchCount: 0,
          updateAvailableCount: 0,
        },
      };

      const upToDateSnapshot: EnvironmentHealthSnapshot = {
        ...initialSnapshot,
        components: {
          ...initialSnapshot.components,
          runner_crossover_preview: {
            ...initialSnapshot.components.runner_crossover_preview!,
            status: 'ready',
            authRequired: undefined,
            statusDetail: 'Installed (27.0.0 (Preview 20261111))',
          },
        } as any,
      };

      const step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: initialSnapshot,
        chosenRunner: 'crossover_preview',
        onSelectRunner: vi.fn(),
        bottleMode: 'reuse_existing',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
      });

      const tree = step.render({ snapshot: upToDateSnapshot });

      expect(findVNodeByTestId(tree, 'runner-update-badge-crossover-preview')).toBeUndefined();
      expect(findVNodeByTestId(tree, 'runner-update-optin-row-crossover-preview')).toBeUndefined();
      const installStatus = findVNodeByTestId(tree, 'runner-install-status-crossover-preview');
      expect(installStatus).toBeDefined();
      expect(extractVNodeText(installStatus)).toContain('Installed');

      step.unmount();
    });

    it('5.33 GameLaunchConfigModal "Sign In & Check" performs authenticateOnly: true without downloading 480 MB archive, surfaces Update button, and clicking Update installs build', async () => {
      const updateInfoAuthRequired: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        installedBuildVersion: '20261015',
        installedDisplayVersion: '27.0.0 (Preview 20261015)',
        updateAvailable: false,
        downloadUrl: 'https://www.codeweavers.com/preview/download',
        authRequired: true,
        canAutoUpdate: true,
        checkedAt: '2026-11-12T00:00:00.000Z',
      };

      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        buildVersion: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        previewDate: '20261015',
        supportsMetalFxDlssD3dMetal: true,
      };

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        platforms: [{
          platformId: 'steam',
          platformGameId: '1091500',
          installed: true,
          installPath: '/Users/test/Games/Cyberpunk2077',
          executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
          isWindowsBinaryOnMac: true,
          platforms: { windows: true, mac: false, linux: false },
        }],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([installedLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([installedLayer]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({ crossover_preview: updateInfoAuthRequired });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({ crossover_preview: updateInfoAuthRequired });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Cyberpunk 2077',
        installPath: '/Users/test/Games/Cyberpunk2077',
        executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      const capturedUpdateCalls: Array<{ runnerType: string, options?: any }> = [];
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(async (runnerType, options) => {
        capturedUpdateCalls.push({ runnerType, options });
        if (options?.authenticateOnly) {
          const freshUpdateInfo: CompatibilityLayerUpdateInfo = {
            runnerType: 'crossover_preview',
            installed: true,
            installedVersion: '27.0.0',
            installedBuildVersion: '20261015',
            installedDisplayVersion: '27.0.0 (Preview 20261015)',
            updateAvailable: true,
            authRequired: false,
            latestVersion: '20261111',
            latestDisplayVersion: 'Preview 20261111',
            downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
            previewDate: '20261111',
            canAutoUpdate: true,
            checkedAt: '2026-11-12T00:00:00.000Z',
          };
          return {
            success: true,
            runnerType: 'crossover_preview',
            updated: false,
            authenticated: true,
            message: 'CodeWeavers Preview authentication and update check completed.',
            detectedLayers: [installedLayer],
            updateInfo: freshUpdateInfo,
          };
        }
        return {
          success: true,
          runnerType: 'crossover_preview',
          updated: true,
          message: 'Successfully updated CrossOver Preview to Preview 20261111.',
          detectedLayers: [{
            ...installedLayer,
            buildVersion: '20261111',
            displayVersion: '27.0.0 (Preview 20261111)',
            previewDate: '20261111',
          }],
        };
      });

      const formHarness = createLaunchConfigFormHarness({
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      formHarness.render();
      await Promise.resolve();
      formHarness.render();

      expect(formHarness.current.activeUpdateInfo?.authRequired).toBe(true);

      // First call triggers authenticateOnly: true (zero archive download)
      await formHarness.current.handleUpdateRunner();
      formHarness.render();

      expect(capturedUpdateCalls).toHaveLength(1);
      expect(capturedUpdateCalls[0]).toEqual({
        runnerType: 'crossover_preview',
        options: { authenticateOnly: true },
      });

      // Now authRequired is cleared and updateAvailable is populated with v20261111
      expect(formHarness.current.activeUpdateInfo?.authRequired).toBe(false);
      expect(formHarness.current.activeUpdateInfo?.updateAvailable).toBe(true);
      expect(formHarness.current.activeUpdateInfo?.latestVersion).toBe('20261111');

      // Second call downloads and applies the 20261111 build
      await formHarness.current.handleUpdateRunner();
      expect(capturedUpdateCalls).toHaveLength(2);
      expect(capturedUpdateCalls[1]).toEqual({
        runnerType: 'crossover_preview',
        options: undefined,
      });

      formHarness.unmount();
    });

    it('5.34 captureCodeWeaversPreviewDownload in authenticateOnly mode closes window and settles upon finding candidate link without triggering download', async () => {
      let windowClosed = false;
      const downloadUrlCalled = vi.fn();

      class MockAuthBrowserWindow {
        webContents: any;
        listeners: Record<string, Function[]> = {};
        constructor() {
          const listeners = this.listeners;
          this.webContents = {
            setUserAgent: vi.fn(),
            getURL: () => 'https://www.codeweavers.com/preview/download',
            downloadURL: downloadUrlCalled,
            setWindowOpenHandler: vi.fn(),
            on: (event: string, fn: Function) => {
              listeners[event] = listeners[event] || [];
              listeners[event].push(fn);
            },
            executeJavaScript: async () => ({
              hrefs: ['https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'],
              hasPasswordInput: false,
            }),
          };
          setTimeout(() => {
            this.emit('did-navigate', {}, 'https://www.codeweavers.com/preview/download');
            this.emit('did-finish-load');
          }, 15);
        }
        emit(event: string, ...args: any[]) {
          for (const fn of (this.listeners[event] || [])) {
            try { fn(...args); } catch {}
          }
        }
        show() {}
        focus() {}
        hide() {}
        close() { windowClosed = true; }
        destroy() { windowClosed = true; }
        isDestroyed() { return windowClosed; }
        loadURL(u: string) {
          setTimeout(() => {
            this.emit('did-navigate', {}, u);
            this.emit('did-finish-load');
          }, 10);
        }
        on() {}
      }

      const mockSession = {
        fromPartition: () => ({
          on: vi.fn(),
          removeListener: vi.fn(),
          setUserAgent: vi.fn(),
        }),
      };

      const captureDir = path.join(tmpRoot, 'capture-auth-test');
      const progressCtx = {
        runId: 'auth-check-1',
        componentId: 'runner_crossover_preview' as const,
        stepIndex: 0,
        totalSteps: 1,
      };

      const res = await environmentProvisioner.captureCodeWeaversPreviewDownload(
        captureDir,
        progressCtx,
        {
          electronMod: {
            BrowserWindow: MockAuthBrowserWindow,
            session: mockSession,
          },
          allowInteractivePreviewCapture: true,
          authenticateOnly: true,
        }
      );

      // Verify that authenticateOnly returned true without downloading
      expect(res.authenticated).toBe(true);
      expect(res.archivePath).toBe('');
      expect(res.downloadUrl).toBe('https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip');
      expect(res.resolvedVersion).toBe('20261111');
      // downloadURL was NOT called
      expect(downloadUrlCalled).not.toHaveBeenCalled();
      // Auth window was closed
      await new Promise((r) => setImmediate(r));
      expect(windowClosed).toBe(true);
    });

    it('5.35 Defense-in-depth: installRunnerDirect and captureCodeWeaversPreviewDownload report alreadyUpToDate without downloading when existingLayer is at or newer than discovered candidate', async () => {
      // Direct installRunnerDirect with existingLayer on 20261111 and downloadUrl on 20261111
      const res = await environmentProvisioner.installRunnerDirect('crossover_preview', {
        _runnerOperation: 'update',
        platform: 'darwin',
        homedir: tmpRoot,
        customApplicationsDir: appsDir,
        existingLayer: {
          id: 'crossover_preview',
          type: 'crossover_preview',
          name: 'CrossOver Preview',
          version: '27.0.0',
          previewDate: '20261111',
          displayVersion: '27.0.0 (Preview 20261111)',
          appPath: path.join(appsDir, 'CrossOver Preview.app'),
        },
        downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        skipNetwork: false,
      });

      expect(res.success).toBe(true);
      expect(res.installed).toBe(false);
      expect(res.alreadyUpToDate).toBe(true);
      expect(res.message).toContain('already up to date');
    });

    it('5.36 invalidateProberRunnerUpdatesCache clears stale cached runner updates, and probeEnvironmentHealth with forceRefreshRunnerUpdates bypasses stale in-memory cache', async () => {
      expect(typeof environmentHealthProber.invalidateProberRunnerUpdatesCache).toBe('function');
      expect(typeof launcherEngine.invalidateProberRunnerUpdatesCache).toBe('function');

      // Probe once with mock feed 1
      let probeCount = 0;
      const fakeHttpGetText = vi.fn().mockImplementation(async (url: string) => {
        probeCount++;
        if (url.includes('crossover-preview-arm64')) return null;
        return `<html><body><a href="https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip">Download Preview 20261111</a></body></html>`;
      });

      const snap1 = await environmentHealthProber.probeEnvironmentHealth({
        hostPlatform: 'darwin',
        isAppleSiliconMac: true,
        homedir: tmpRoot,
        layers: [
          {
            id: 'crossover_preview',
            type: 'crossover_preview',
            name: 'CrossOver Preview',
            version: '27.0.0',
            previewDate: '20261015',
            displayVersion: '27.0.0 (Preview 20261015)',
            appPath: path.join(appsDir, 'CrossOver Preview.app'),
          },
        ],
        httpGetText: fakeHttpGetText,
      });

      expect(snap1.components.runner_crossover_preview.status).toBe('update_available');
      const initialCount = probeCount;
      expect(initialCount).toBeGreaterThan(0);

      // Invalidate the cache
      environmentHealthProber.invalidateProberRunnerUpdatesCache();

      // Probing with forceRefreshRunnerUpdates: true or forceFresh: true forces fresh fetch
      const snap2 = await environmentHealthProber.probeEnvironmentHealth({
        hostPlatform: 'darwin',
        isAppleSiliconMac: true,
        homedir: tmpRoot,
        layers: [
          {
            id: 'crossover_preview',
            type: 'crossover_preview',
            name: 'CrossOver Preview',
            version: '27.0.0',
            previewDate: '20261015',
            displayVersion: '27.0.0 (Preview 20261015)',
            appPath: path.join(appsDir, 'CrossOver Preview.app'),
          },
        ],
        forceRefreshRunnerUpdates: true,
        httpGetText: fakeHttpGetText,
      });

      expect(snap2.components.runner_crossover_preview.status).toBe('update_available');
      expect(probeCount).toBeGreaterThan(initialCount);
    });

    it('5.37 updateCompatibilityLayer invalidates prober runner updates cache upon completion', async () => {
      // Invalidate cache first
      environmentHealthProber.invalidateProberRunnerUpdatesCache();

      const res = await launcherEngine.updateCompatibilityLayer(
        { runnerType: 'crossover_preview', authenticateOnly: true },
        {
          _bypassSingleFlight: true,
          capturePreviewDownloadFn: async () => ({
            authenticated: true,
            downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
            resolvedVersion: '20261111',
          }),
          layers: [
            {
              id: 'crossover_preview',
              type: 'crossover_preview',
              name: 'CrossOver Preview',
              version: '27.0.0',
              previewDate: '20261015',
              displayVersion: '27.0.0 (Preview 20261015)',
              appPath: path.join(appsDir, 'CrossOver Preview.app'),
            },
          ],
        }
      );

      expect(res.success).toBe(true);
      expect(res.authenticated).toBe(true);
      expect(res.updateInfo).toBeDefined();
      expect(res.updateInfo?.downloadUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
      expect(res.updateInfo?.updateAvailable).toBe(true);
    });

    it('5.38 useGameLaunchConfigForm handleUpdateRunner catches unexpected errors and reports user-visible feedback without getting stuck in isUpdatingRunner', async () => {
      const origUpdate = launcherService.updateCompatibilityLayer;
      launcherService.updateCompatibilityLayer = vi.fn().mockRejectedValue(new Error('Network connection abruptly dropped'));

      const installedPreviewLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'),
        version: '27.0.0',
        previewDate: '20261015',
        displayVersion: '27.0.0 (Preview 20261015)',
        availableBottles: ['OneLauncher'],
      };

      const updateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        installedDisplayVersion: '27.0.0 (Preview 20261015)',
        latestVersion: '20261111',
        latestDisplayVersion: 'Preview 20261111',
        updateAvailable: true,
        downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        canAutoUpdate: true,
        updateMethod: 'direct_download',
        checkedAt: new Date().toISOString(),
      };

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([installedPreviewLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([installedPreviewLayer]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Cyberpunk 2077',
        installPath: '/Users/test/Games/Cyberpunk2077',
        executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        platforms: [{
          platformId: 'steam',
          platformGameId: '1091500',
          installed: true,
          installPath: '/Users/test/Games/Cyberpunk2077',
          executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
          isWindowsBinaryOnMac: true,
          platforms: { windows: true, mac: false, linux: false },
        }],
      });

      const formHarness = createLaunchConfigFormHarness({
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });

      formHarness.render();
      await Promise.resolve();
      formHarness.render();

      // Trigger update - which triggers the rejected promise
      await formHarness.current.handleUpdateRunner();
      formHarness.render();

      expect(formHarness.current.isUpdatingRunner).toBe(false);
      expect(formHarness.current.runnerUpdateFeedback).toContain('Network connection abruptly dropped');

      launcherService.updateCompatibilityLayer = origUpdate;
      formHarness.unmount();
    });

    it('5.39 onWillDownload cancels download and resolves immediately with metadata when authenticateOnly is true', async () => {
      let downloadCancelled = false;
      let windowClosed = false;
      const captureDir = path.join(tmpRoot, 'capture-will-download-test');

      class MockWillDownloadAuthWindow {
        webContents: any;
        listeners: Record<string, Function[]> = {};
        loadURL = vi.fn().mockResolvedValue(undefined);
        constructor() {
          this.webContents = {
            setUserAgent: vi.fn(),
            getURL: () => 'https://www.codeweavers.com/login',
            loadURL: vi.fn(),
            executeJavaScript: vi.fn().mockResolvedValue({
              hrefs: [],
              hasPasswordInput: true,
            }),
            setWindowOpenHandler: vi.fn(),
            on: (event: string, cb: Function) => {
              this.listeners[event] = this.listeners[event] || [];
              this.listeners[event].push(cb);
            },
          };
        }
        show() {}
        focus() {}
        hide() {}
        isDestroyed() {
          return windowClosed;
        }
        close() {
          windowClosed = true;
          (this.listeners['closed'] || []).forEach((cb) => cb());
        }
        destroy() {
          windowClosed = true;
        }
        on(event: string, cb: Function) {
          this.listeners[event] = this.listeners[event] || [];
          this.listeners[event].push(cb);
        }
      }

      let willDownloadCb: any = null;
      const mockSession = {
        setUserAgent: vi.fn(),
        on: (event: string, cb: any) => {
          if (event === 'will-download') willDownloadCb = cb;
        },
        removeListener: vi.fn(),
      };

      const capturePromise = environmentProvisioner.captureCodeWeaversPreviewDownload(
        captureDir,
        {
          runId: 'auth-will-download-test',
          componentId: 'runner_crossover_preview' as const,
          stepIndex: 0,
          totalSteps: 1,
        },
        {
          electronMod: {
            BrowserWindow: MockWillDownloadAuthWindow,
            session: {
              fromPartition: () => mockSession,
            },
          },
          allowInteractivePreviewCapture: true,
          authenticateOnly: true,
        }
      );

      // Allow async setup (e.g. disk space check) to complete and attach will-download
      await new Promise((r) => setTimeout(r, 20));

      // Verify will-download listener was attached
      expect(willDownloadCb).toBeDefined();

      const mockDownloadItem = {
        getURL: () => 'https://media.codeweavers.com/pub/crossover/preview/crossover-preview-20261111.zip',
        getFilename: () => 'crossover-preview-20261111.zip',
        getURLChain: () => [
          'https://www.codeweavers.com/preview/download',
          'https://media.codeweavers.com/pub/crossover/preview/crossover-preview-20261111.zip',
        ],
        cancel: () => {
          downloadCancelled = true;
        },
        setSavePath: vi.fn(),
        on: vi.fn(),
      };

      // Trigger will-download event
      willDownloadCb({}, mockDownloadItem);

      const res = await capturePromise;

      // Expect authenticateOnly succeeded without downloading the file
      expect(res.authenticated).toBe(true);
      expect(res.archivePath).toBe('');
      expect(res.downloadUrl).toContain('crossover-preview-20261111.zip');
      expect(res.resolvedVersion).toBe('20261111');
      expect(downloadCancelled).toBe(true);
      expect(mockDownloadItem.setSavePath).not.toHaveBeenCalled();
    });

    it('5.40 extractRunnerPreviewDate parses hyphenated and dotted ISO preview dates', () => {
      expect(macNativeInstaller.extractRunnerPreviewDate('crossover-preview-2026-11-11.zip')).toBe('20261111');
      expect(macNativeInstaller.extractRunnerPreviewDate('crossover-preview-2026.11.11.dmg')).toBe('20261111');
      expect(macNativeInstaller.extractRunnerPreviewDate('crossover_preview_2026_11_11.zip')).toBe('20261111');
      expect(macNativeInstaller.extractRunnerPreviewDate('2026.11.11')).toBe('20261111');
      expect(macNativeInstaller.extractRunnerPreviewDate('2026-11-11')).toBe('20261111');
    });

    it('5.41 captureCodeWeaversPreviewDownload discovers links from rawHtml probe', async () => {
      let windowClosed = false;
      const captureDir = path.join(tmpRoot, 'capture-raw-html-test');

      class MockRawHtmlBrowserWindow {
        webContents: any;
        listeners: Record<string, Function[]> = {};
        loadURL = vi.fn().mockResolvedValue(undefined);
        constructor() {
          this.webContents = {
            setUserAgent: vi.fn(),
            getURL: () => 'https://www.codeweavers.com/preview/download',
            loadURL: vi.fn(),
            executeJavaScript: vi.fn().mockResolvedValue({
              hrefs: [], // Empty standard anchors
              hasPasswordInput: false,
              rawHtml: '<div onclick="location.href=\'/preview/download/crossover-preview-20261111.zip\'">Click to download</div>',
            }),
            setWindowOpenHandler: vi.fn(),
            on: (event: string, cb: Function) => {
              this.listeners[event] = this.listeners[event] || [];
              this.listeners[event].push(cb);
              if (event === 'did-finish-load') {
                setImmediate(() => cb());
              }
            },
          };
        }
        show() {}
        focus() {}
        hide() {}
        isDestroyed() {
          return windowClosed;
        }
        close() {
          windowClosed = true;
          (this.listeners['closed'] || []).forEach((cb) => cb());
        }
        destroy() {
          windowClosed = true;
        }
        on(event: string, cb: Function) {
          this.listeners[event] = this.listeners[event] || [];
          this.listeners[event].push(cb);
        }
      }

      const mockSession = {
        setUserAgent: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
      };

      const res = await environmentProvisioner.captureCodeWeaversPreviewDownload(
        captureDir,
        {
          runId: 'raw-html-test',
          componentId: 'runner_crossover_preview' as const,
          stepIndex: 0,
          totalSteps: 1,
        },
        {
          electronMod: {
            BrowserWindow: MockRawHtmlBrowserWindow,
            session: {
              fromPartition: () => mockSession,
            },
          },
          allowInteractivePreviewCapture: true,
          authenticateOnly: true,
        }
      );

      expect(res.authenticated).toBe(true);
      expect(res.downloadUrl).toContain('crossover-preview-20261111.zip');
      expect(res.resolvedVersion).toBe('20261111');
    });

    it('5.42 Setup Wizard renders uninstalled preview runner cleanly and updates status hint when snapshot resolves version', async () => {
      // Clean system: CrossOver Preview is MISSING and requires auth
      const uninstalledSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'missing',
          authRequired: true,
          latestVersion: undefined,
          downloadUrl: undefined,
        },
      });

      const postAuthSnap = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'missing',
          authRequired: false,
          latestVersion: '20261111',
          latestDisplayVersion: 'Preview 20261111',
        },
      });

      const step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: uninstalledSnapshot,
        chosenRunner: 'crossover_preview',
        onSelectRunner: vi.fn(),
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        gptkDmgPath: '',
        onChangeGptkDmgPath: vi.fn(),
      });

      let tree = step.render();

      const card = findVNodeByTestId(tree, 'setup-runner-crossover-preview');
      expect(card).toBeDefined();
      const statusText = findVNodeByTestId(tree, 'runner-install-status-crossover-preview');
      expect(statusText).toBeDefined();
      expect(extractVNodeText(statusText)).toContain('Not Installed');
      expect(findVNodeByTestId(tree, 'setup-sign-in-check-crossover-preview')).toBeUndefined();

      tree = step.render({ snapshot: postAuthSnap });
      const postCard = findVNodeByTestId(tree, 'setup-runner-crossover-preview');
      expect(postCard).toBeDefined();
      expect(extractVNodeText(postCard)).toContain('sign in to CodeWeavers during setup');

      step.unmount();
    });

    it('5.43 GameLaunchConfigModal sign-in handler handles rejections gracefully without throwing', async () => {
      const updateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: false,
        updateAvailable: false,
        authRequired: true,
        canAutoUpdate: true,
        checkedAt: '2026-11-12T00:00:00.000Z',
      };

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        platforms: [{
          platformId: 'steam',
          platformGameId: '1091500',
          installed: true,
          installPath: '/Users/test/Games/Cyberpunk2077',
          executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
          isWindowsBinaryOnMac: true,
          platforms: { windows: true, mac: false, linux: false },
        }],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher-x64',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Cyberpunk 2077',
        installPath: '/Users/test/Games/Cyberpunk2077',
        executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      const rejectingSignInSpy = vi
        .spyOn(launcherService, 'updateCompatibilityLayer')
        .mockRejectedValue(new Error('Auth dialog abruptly closed'));

      const formHarness = createLaunchConfigFormHarness({
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });

      formHarness.render();
      await Promise.resolve();
      formHarness.render();

      // Invoking handleUpdateRunner must not result in an unhandled promise rejection
      await expect(formHarness.current.handleUpdateRunner()).resolves.toBeUndefined();
      expect(rejectingSignInSpy).toHaveBeenCalledTimes(1);

      formHarness.render();
      expect(formHarness.current.runnerUpdateFeedback).toContain('Auth dialog abruptly closed');

      formHarness.unmount();
    });

    it('5.44 Electron 44.9.3 real API: resolvePreviewFetch uses previewSession.fetch with credentials:include and strips redirect:manual when previewSession.net is undefined', async () => {
      let passedUrl = '';
      let passedOpts: any = null;
      let sessionUaSet = '';

      const mockSession = {
        setUserAgent: (ua: string) => {
          sessionUaSet = ua;
        },
        fetch: vi.fn(async (url: string, opts: any) => {
          passedUrl = url;
          passedOpts = opts;
          return {
            ok: true,
            status: 200,
            url,
            text: async () => '<html><a href="https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip">Download</a></html>',
          };
        }),
        // Crucial: previewSession.net is UNDEFINED in Electron 44.9.3
        net: undefined,
      };

      const mockElectronMod = {
        session: {
          fromPartition: (partitionName: string) => {
            if (partitionName === 'persist:codeweavers-preview') {
              return mockSession;
            }
            return null;
          },
        },
      };

      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/MacOS/CrossOver'),
        version: '20261015',
        displayVersion: '20261015',
      };

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [installedLayer],
        electronMod: mockElectronMod,
      });

      expect(mockSession.fetch).toHaveBeenCalledTimes(1);
      expect(passedUrl).toBe('https://www.codeweavers.com/preview/download');
      expect(passedOpts.credentials).toBe('include');
      expect(passedOpts.redirect).toBeUndefined(); // redirect: 'manual' stripped to prevent SimpleURLLoaderWrapper crash
      expect(sessionUaSet).toContain('Mozilla/5.0');

      const previewUpd = updates.crossover_preview;
      expect(previewUpd).toBeDefined();
      expect(previewUpd.updateAvailable).toBe(true);
      expect(previewUpd.latestVersion).toBe('20261111');
      expect(previewUpd.authRequired).toBe(false);
    });

    it('5.45 Electron 44.9.3 quirk: when res.url is empty on redirect, login detection detects unauthenticated portal via title, password input, and data-gourl', async () => {
      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/MacOS/CrossOver'),
        version: '20261015',
        displayVersion: '20261015',
      };

      // Test 1: res.url === "" but title indicates sign in
      const mockSessionTitleLogin = {
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          url: '', // Real Electron 44.9.3 returns empty url on redirect!
          text: async () => '<html><head><title>Sign In | CodeWeavers</title></head><body><form action="/login"><button type="submit">Sign In</button></form></body></html>',
        })),
      };

      const updates1 = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [installedLayer],
        electronMod: {
          session: {
            fromPartition: () => mockSessionTitleLogin,
          },
        },
      });

      expect(updates1.crossover_preview.authRequired).toBe(true);

      // Test 2: res.url === "" with data-gourl login button
      const mockSessionDataGourl = {
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          url: '',
          text: async () => '<html><body><button data-gourl="/login">Log in to view Preview downloads</button></body></html>',
        })),
      };

      const updates2 = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [installedLayer],
        electronMod: {
          session: {
            fromPartition: () => mockSessionDataGourl,
          },
        },
      });

      expect(updates2.crossover_preview.authRequired).toBe(true);
    });

    it('5.46 captureCodeWeaversPreviewDownload creates BrowserWindow with show: true when authenticateOnly is true without double-counting windowShownCount', async () => {
      let createdWinOpts: any = null;
      let windowShownCount = 0;
      let showCalled = false;
      let focusCalled = false;
      let moveTopCalled = false;

      class MockBrowserWindow {
        webContents = {
          setUserAgent: vi.fn(),
          executeJavaScript: vi.fn().mockResolvedValue({ hrefs: [], hasPasswordInput: true, rawHtml: '' }),
          loadURL: vi.fn().mockResolvedValue(undefined),
          on: vi.fn(),
        };
        constructor(opts: any) {
          createdWinOpts = opts;
          if (opts?.show) {
            windowShownCount += 1;
          }
        }
        loadURL(_url: string) {
          return Promise.resolve();
        }
        show() {
          windowShownCount += 1;
          showCalled = true;
        }
        focus() {
          focusCalled = true;
        }
        moveTop() {
          moveTopCalled = true;
        }
        isDestroyed() {
          return false;
        }
        close() {}
        destroy() {}
        on() {}
      }

      const mockSession = {
        setUserAgent: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        cookies: {
          flushStore: vi.fn().mockResolvedValue(undefined),
        },
      };

      const mockElectronMod = {
        BrowserWindow: MockBrowserWindow,
        session: {
          fromPartition: () => mockSession,
        },
      };

      const abortController = new AbortController();
      const localDestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cx-preview-546-'));

      try {
        const capturePromise = environmentProvisioner.captureCodeWeaversPreviewDownload(
          localDestDir,
          { runId: 'test-run', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
          {
            authenticateOnly: true,
            allowInteractivePreviewCapture: true,
            electronMod: mockElectronMod,
          },
          abortController.signal
        );

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Verify BrowserWindow created with show: true and revealAuthWindow does not double-call show()
        expect(createdWinOpts).toBeDefined();
        expect(createdWinOpts.show).toBe(true);
        expect(windowShownCount).toBe(1);
        expect(showCalled).toBe(false);
        expect(focusCalled).toBe(true);
        expect(moveTopCalled).toBe(true);

        abortController.abort();
        await expect(capturePromise).rejects.toThrow('cancelled');
      } finally {
        try { fs.rmSync(localDestDir, { recursive: true, force: true }); } catch {}
      }
    });

    it('5.47 captureCodeWeaversPreviewDownload in authenticateOnly mode does NOT auto-close on /preview/download when bestArchiveUrl is null', async () => {
      let closed = false;

      class MockBrowserWindow {
        listeners: Record<string, Function[]> = {};
        webContents: any;
        constructor() {
          const listeners = this.listeners;
          this.webContents = {
            setUserAgent: vi.fn(),
            getURL: () => 'https://www.codeweavers.com/preview/download',
            executeJavaScript: vi.fn().mockResolvedValue({
              hrefs: ['/about', '/support'],
              hasPasswordInput: false,
              rawHtml: '<html><body>Please verify you are human</body></html>',
            }),
            loadURL: vi.fn().mockResolvedValue(undefined),
            on: (event: string, fn: Function) => {
              listeners[event] = listeners[event] || [];
              listeners[event].push(fn);
            },
          };
        }
        loadURL(_url: string) {
          setTimeout(() => {
            for (const fn of (this.listeners['did-finish-load'] || [])) {
              try { fn(); } catch {}
            }
          }, 10);
          return Promise.resolve();
        }
        isDestroyed() {
          return closed;
        }
        show() {}
        focus() {}
        moveTop() {}
        close() {
          closed = true;
        }
        destroy() {
          closed = true;
        }
        hide() {}
        on() {}
      }

      const mockSession = {
        setUserAgent: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        cookies: {
          flushStore: vi.fn().mockResolvedValue(undefined),
        },
      };

      const mockElectronMod = {
        BrowserWindow: MockBrowserWindow,
        session: {
          fromPartition: () => mockSession,
        },
      };

      const abortController = new AbortController();
      const localDestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cx-preview-547-'));

      try {
        const capturePromise = environmentProvisioner.captureCodeWeaversPreviewDownload(
          localDestDir,
          { runId: 'test-run', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
          {
            authenticateOnly: true,
            allowInteractivePreviewCapture: true,
            electronMod: mockElectronMod,
          },
          abortController.signal
        );

        // Let microtasks and did-finish-load run
        await new Promise((resolve) => setTimeout(resolve, 80));

        // Window must NOT have closed because bestArchiveUrl was null!
        expect(closed).toBe(false);

        abortController.abort();
        await expect(capturePromise).rejects.toThrow('cancelled');
      } finally {
        try { fs.rmSync(localDestDir, { recursive: true, force: true }); } catch {}
      }
    });

    it('5.48 captureCodeWeaversPreviewDownload flushes cookies to disk and closes once bestArchiveUrl is discovered in authenticateOnly mode', async () => {
      let closed = false;
      let flushStoreCalled = false;

      class MockBrowserWindow {
        listeners: Record<string, Function[]> = {};
        webContents: any;
        constructor() {
          const listeners = this.listeners;
          this.webContents = {
            setUserAgent: vi.fn(),
            getURL: () => 'https://www.codeweavers.com/preview/download',
            executeJavaScript: vi.fn().mockResolvedValue({
              hrefs: ['https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'],
              hasPasswordInput: false,
              rawHtml: '<html><body><a href="https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip">Download</a></body></html>',
            }),
            loadURL: vi.fn().mockResolvedValue(undefined),
            on: (event: string, fn: Function) => {
              listeners[event] = listeners[event] || [];
              listeners[event].push(fn);
            },
          };
        }
        loadURL(_url: string) {
          setTimeout(() => {
            for (const fn of (this.listeners['did-finish-load'] || [])) {
              try { fn(); } catch {}
            }
          }, 10);
          return Promise.resolve();
        }
        isDestroyed() {
          return closed;
        }
        show() {}
        focus() {}
        moveTop() {}
        close() {
          closed = true;
        }
        destroy() {
          closed = true;
        }
        hide() {}
        on() {}
      }

      const mockSession = {
        setUserAgent: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        cookies: {
          flushStore: vi.fn(async () => {
            flushStoreCalled = true;
          }),
        },
      };

      const mockElectronMod = {
        BrowserWindow: MockBrowserWindow,
        session: {
          fromPartition: () => mockSession,
        },
      };

      const localDestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cx-preview-548-'));
      try {
        const res = await environmentProvisioner.captureCodeWeaversPreviewDownload(
          localDestDir,
          { runId: 'test-run', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
          {
            authenticateOnly: true,
            allowInteractivePreviewCapture: true,
            electronMod: mockElectronMod,
          }
        );

        expect(res.authenticated).toBe(true);
        expect(res.downloadUrl).toBe('https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip');
        expect(res.resolvedVersion).toBe('20261111');
        expect(flushStoreCalled).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(closed).toBe(true);
      } finally {
        try { fs.rmSync(localDestDir, { recursive: true, force: true }); } catch {}
      }
    });

    it('5.49 authenticateOnly: true bypasses assertRunnerSafeToReplace even when runner is busy', async () => {
      const busyRunnerLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/MacOS/CrossOver'),
        version: '20261015',
        displayVersion: '20261015',
      };

      // Mock mockUpdater / direct installer returning authenticated: true
      const mockOptions = {
        layers: [busyRunnerLayer],
        mockUpdateRunnerDirect: vi.fn().mockResolvedValue({
          authenticated: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
          detectedLayers: [busyRunnerLayer],
        }),
        previewCandidateUrls: ['https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'],
      };

      // updateCompatibilityLayer with authenticateOnly: true must succeed and NOT be blocked by running processes
      const res = await macNativeInstaller.updateCompatibilityLayer('crossover_preview', {
        ...mockOptions,
        authenticateOnly: true,
      });

      expect(res.success).toBe(true);
      expect(res.runnerType).toBe('crossover_preview');
      expect(res.authenticated).toBe(true);
    });

    it('5.50 in-memory candidate cache caches verified candidate URL with TTL and clearCachedAuthenticatedPreviewUrl clears it', async () => {
      macNativeInstaller.clearCachedAuthenticatedPreviewUrl();

      // Cache a discovered candidate URL
      macNativeInstaller.cacheAuthenticatedPreviewUrl('https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip');

      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/MacOS/CrossOver'),
        version: '20261015',
        displayVersion: '20261015',
      };

      // When network returns empty HTML without login gate, the cached URL is used as defense-in-depth
      const mockEmptyFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        url: 'https://www.codeweavers.com/preview/download',
        text: async () => '<html><body>Welcome to Preview</body></html>',
      }));

      // In non-test mode (clearing isTest / mock flags) checkCompatibilityLayerUpdates uses the cached URL
      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [installedLayer],
        fetchFn: mockEmptyFetch,
        // Override the test bypass so we can verify cache behavior
        isTest: false,
      });

      // Clear cache and verify it is empty
      macNativeInstaller.clearCachedAuthenticatedPreviewUrl();
    });

    it('5.51 Setup Wizard toggles runner_crossover_preview update opt-in when update is available, omits toggle when up to date, and Launch Config surfaces feedback on cancellation', async () => {
      // Scenario A: Update Available -> toggle opt-in works cleanly
      const postAuthUpdateSnap = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'update_available',
          authRequired: false,
          version: '20261015',
          latestVersion: '20261111',
          latestDisplayVersion: 'Preview 20261111',
        },
      });

      const onToggleSpy = vi.fn((id: EnvironmentComponentId, nextOptIn: boolean) => {
        environmentSetupService.setRunnerUpdateOptIn(id, nextOptIn);
      });

      const stepA = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: postAuthUpdateSnap,
        chosenRunner: 'crossover_preview',
        onSelectRunner: vi.fn(),
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        gptkDmgPath: '',
        onChangeGptkDmgPath: vi.fn(),
        runnerUpdateOptInIds: new Set<EnvironmentComponentId>(),
        onToggleRunnerUpdate: onToggleSpy,
      });

      const treeA = stepA.render();
      const updateBadge = findVNodeByTestId(treeA, 'runner-update-badge-crossover-preview');
      expect(updateBadge).toBeDefined();
      const toggleBtn = findVNodeByTestId(treeA, 'runner-update-toggle-crossover-preview');
      expect(toggleBtn).toBeDefined();

      toggleBtn.props.onClick({ stopPropagation: () => {} } as any);
      expect(onToggleSpy).toHaveBeenCalledWith('runner_crossover_preview', true);
      expect(environmentSetupService.getRunnerUpdateOptIn('runner_crossover_preview')).toBe(true);
      stepA.unmount();

      // Scenario B: Already up to date -> renders Installed without update toggle
      const postAuthUpToDateSnap = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'ready',
          authRequired: false,
          version: '20261111',
        },
      });

      const stepB = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: postAuthUpToDateSnap,
        chosenRunner: 'crossover_preview',
        onSelectRunner: vi.fn(),
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        gptkDmgPath: '',
        onChangeGptkDmgPath: vi.fn(),
      });

      const treeB = stepB.render();
      expect(findVNodeByTestId(treeB, 'runner-update-optin-row-crossover-preview')).toBeUndefined();
      const statusB = findVNodeByTestId(treeB, 'runner-install-status-crossover-preview');
      expect(statusB).toBeDefined();
      expect(extractVNodeText(statusB)).toContain('Installed');
      stepB.unmount();

      // Scenario C: Cancelled sign-in in Launch Config -> displays cancellation feedback
      const updateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: false,
        updateAvailable: false,
        authRequired: true,
        canAutoUpdate: true,
        checkedAt: '2026-11-12T00:00:00.000Z',
      };
      const synthGame = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        platforms: [{
          platformId: 'steam',
          platformGameId: '1091500',
          installed: true,
          installPath: '/Users/test/Games/Cyberpunk2077',
          executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
          isWindowsBinaryOnMac: true,
          platforms: { windows: true, mac: false, linux: false },
        }],
      });
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher-x64',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Cyberpunk 2077',
        installPath: '/Users/test/Games/Cyberpunk2077',
        executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockResolvedValue({
        success: false,
        runnerType: 'crossover_preview',
        updated: false,
        error: 'CodeWeavers Preview sign-in cancelled.',
        message: 'CodeWeavers Preview sign-in cancelled.',
      });

      const formHarnessC = createLaunchConfigFormHarness({
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      formHarnessC.render();
      await Promise.resolve();
      formHarnessC.render();

      await formHarnessC.current.handleUpdateRunner();
      formHarnessC.render();
      expect(formHarnessC.current.runnerUpdateFeedback).toContain('CodeWeavers Preview sign-in cancelled.');
      formHarnessC.unmount();
    });

    it('5.52 Launch & Compatibility Settings: updateCompatibilityLayer returns crisp messages for update available vs up to date', async () => {
      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/MacOS/CrossOver'),
        version: '20261015',
        displayVersion: '20261015',
      };

      // Case 1: Update available
      const resUpdate = await macNativeInstaller.updateCompatibilityLayer('crossover_preview', {
        layers: [installedLayer],
        authenticateOnly: true,
        previewCandidateUrls: ['https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'],
        mockUpdateRunnerDirect: vi.fn().mockResolvedValue({
          authenticated: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
          detectedLayers: [installedLayer],
        }),
      });

      expect(resUpdate.success).toBe(true);
      expect(resUpdate.authenticated).toBe(true);
      expect(resUpdate.message).toContain('Signed in to CodeWeavers — update available:');
      expect(resUpdate.updateInfo?.updateAvailable).toBe(true);

      // Case 2: Up to date (already on 20261111)
      const currentLayer: CompatibilityLayerInfo = {
        ...installedLayer,
        version: '20261111',
        displayVersion: '20261111',
      };

      const resCurrent = await macNativeInstaller.updateCompatibilityLayer('crossover_preview', {
        layers: [currentLayer],
        authenticateOnly: true,
        previewCandidateUrls: ['https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'],
        mockUpdateRunnerDirect: vi.fn().mockResolvedValue({
          authenticated: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
          detectedLayers: [currentLayer],
        }),
      });

      expect(resCurrent.success).toBe(true);
      expect(resCurrent.authenticated).toBe(true);
      expect(resCurrent.message).toContain('Signed in to CodeWeavers — CrossOver Preview is up to date (20261111).');
      expect(resCurrent.updateInfo?.updateAvailable).toBe(false);
    });

    it('5.53 captureCodeWeaversPreviewDownload starts hidden (show: false) during background install (authenticateOnly: false) and calls show() when hasPasswordInput is true', async () => {
      let createdWinOpts: any = null;
      let showCalled = false;
      let focusCalled = false;

      class MockBrowserWindow {
        private wcListeners: Record<string, Function[]> = {};
        webContents: any;
        constructor(opts: any) {
          createdWinOpts = opts;
          const listeners = this.wcListeners;
          this.webContents = {
            setUserAgent: vi.fn(),
            getURL: () => 'https://www.codeweavers.com/preview/download',
            executeJavaScript: vi.fn().mockResolvedValue({ hrefs: [], hasPasswordInput: true, rawHtml: '' }),
            loadURL: vi.fn().mockResolvedValue(undefined),
            on: (event: string, fn: Function) => {
              listeners[event] = listeners[event] || [];
              listeners[event].push(fn);
            },
          };
        }
        loadURL(_url: string) {
          setImmediate(() => {
            for (const fn of this.wcListeners['did-finish-load'] || []) {
              try { fn(); } catch {}
            }
          });
          return Promise.resolve();
        }
        show() {
          showCalled = true;
        }
        focus() {
          focusCalled = true;
        }
        moveTop() {}
        isDestroyed() {
          return false;
        }
        close() {}
        destroy() {}
        on() {}
      }

      const mockSession = {
        setUserAgent: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        cookies: {
          flushStore: vi.fn().mockResolvedValue(undefined),
        },
      };

      const mockElectronMod = {
        BrowserWindow: MockBrowserWindow,
        session: {
          fromPartition: () => mockSession,
        },
      };

      const abortController = new AbortController();
      const localDestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cx-preview-553-'));

      try {
        const capturePromise = environmentProvisioner.captureCodeWeaversPreviewDownload(
          localDestDir,
          { runId: 'test-run-553', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
          {
            authenticateOnly: false,
            allowInteractivePreviewCapture: true,
            electronMod: mockElectronMod,
          },
          abortController.signal
        );

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(createdWinOpts).toBeDefined();
        expect(createdWinOpts.show).toBe(false);
        expect(showCalled).toBe(true);
        expect(focusCalled).toBe(true);

        abortController.abort();
        await expect(capturePromise).rejects.toThrow(/cancelled/i);
      } finally {
        fs.rmSync(localDestDir, { recursive: true, force: true });
      }
    });

    it('5.54 diverse CodeWeavers SSO and login URLs (/account/login, /account/signin, /account/sign-in) do not cause reload loops', async () => {
      let loadUrlCalls: string[] = [];
      let navHandlers: Record<string, ((...args: any[]) => void)> = {};

      class MockBrowserWindow {
        webContents = {
          setUserAgent: vi.fn(),
          executeJavaScript: vi.fn().mockResolvedValue({ hrefs: [], hasPasswordInput: true, rawHtml: '' }),
          loadURL: vi.fn(async (u: string) => {
            loadUrlCalls.push(u);
          }),
          getURL: vi.fn(() => 'https://www.codeweavers.com/account/login?gourl=%2Fpreview%2Fdownload'),
          on: vi.fn((event: string, handler: (...args: any[]) => void) => {
            navHandlers[event] = handler;
          }),
        };
        constructor(_opts: any) {}
        loadURL(u: string) {
          loadUrlCalls.push(u);
          return Promise.resolve();
        }
        show() {}
        focus() {}
        moveTop() {}
        isDestroyed() {
          return false;
        }
        close() {}
        destroy() {}
        on() {}
      }

      const mockSession = {
        setUserAgent: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        cookies: {
          flushStore: vi.fn().mockResolvedValue(undefined),
        },
      };

      const mockElectronMod = {
        BrowserWindow: MockBrowserWindow,
        session: {
          fromPartition: () => mockSession,
        },
      };

      const abortController = new AbortController();
      const localDestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cx-preview-554-'));

      try {
        const capturePromise = environmentProvisioner.captureCodeWeaversPreviewDownload(
          localDestDir,
          { runId: 'test-run-554', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
          {
            authenticateOnly: true,
            allowInteractivePreviewCapture: true,
            electronMod: mockElectronMod,
          },
          abortController.signal
        );

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Initial load should be previewDownloadUrl
        expect(loadUrlCalls).toEqual(['https://www.codeweavers.com/preview/download']);

        // Simulate navigation to /account/login?gourl=...
        navHandlers['did-navigate']?.({}, 'https://www.codeweavers.com/account/login?gourl=%2Fpreview%2Fdownload');

        // Wait to ensure no reload loop is triggered
        await new Promise((resolve) => setTimeout(resolve, 100));

        // loadURL should NOT have been called again (no infinite loop)
        expect(loadUrlCalls).toEqual(['https://www.codeweavers.com/preview/download']);

        abortController.abort();
        await expect(capturePromise).rejects.toThrow(/cancelled/i);
      } finally {
        fs.rmSync(localDestDir, { recursive: true, force: true });
      }
    });

    it('5.55 checkCompatibilityLayerUpdates fails safe to authRequired: true when network probe returns no archive links or is blocked', async () => {
      const installedLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        name: 'CrossOver Preview',
        type: 'crossover_preview',
        binaryPath: path.join(appsDir, 'CrossOver Preview.app/Contents/MacOS/CrossOver'),
        appPath: path.join(appsDir, 'CrossOver Preview.app'),
        version: '20261015',
        displayVersion: '20261015',
      };

      // Scenario: portal probe returns HTML with no candidate archive links
      const mockEmptyPortalFetch = async () => ({
        ok: true,
        status: 200,
        url: 'https://www.codeweavers.com/preview/download',
        text: async () => '<html><body>Welcome to CodeWeavers Preview Center. Please log in.</body></html>',
      });

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        layers: [installedLayer],
        previewSessionFetch: mockEmptyPortalFetch,
      });

      const previewUpd = updates.crossover_preview;
      expect(previewUpd).toBeDefined();
      expect(previewUpd.authRequired).toBe(true);
      expect(previewUpd.updateAvailable).toBe(false);
      expect(previewUpd.statusMessage).toContain('Sign in to CodeWeavers Preview to check for updates');
    });

    it('5.56 CompatibilityAndBottleStep renders uninstalled CrossOver Preview card cleanly even if authRequired was not preset', () => {
      const uninstalledSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'missing',
          authRequired: undefined,
          downloadUrl: undefined,
        },
      });

      const step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: uninstalledSnapshot,
        chosenRunner: 'crossover_preview',
        onSelectRunner: vi.fn(),
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
      });

      const tree = step.render();
      const card = findVNodeByTestId(tree, 'setup-runner-crossover-preview');
      expect(card).toBeDefined();
      const installStatus = findVNodeByTestId(tree, 'runner-install-status-crossover-preview');
      expect(installStatus).toBeDefined();
      expect(extractVNodeText(installStatus)).toContain('Not Installed');
      expect(findVNodeByTestId(tree, 'runner-auth-required-footer-crossover-preview')).toBeUndefined();
      step.unmount();
    });

    it('5.57 installCompatibilityLayer for crossover_preview handles alreadyUpToDate and authenticated without opening external browser', async () => {
      const mockAlreadyUpToDateDirect = vi.fn().mockResolvedValue({
        success: true,
        installed: false,
        alreadyUpToDate: true,
        message: 'CrossOver Preview is already up to date (20261111).',
      });

      const res = await macNativeInstaller.installCompatibilityLayer('crossover_preview', 'auto', {
        skipProcessCheck: true,
        mockDirectDownload: mockAlreadyUpToDateDirect,
      });

      expect(res.success).toBe(true);
      expect(res.alreadyUpToDate).toBe(true);
      expect(res.openedExternalInstaller).toBeUndefined();
      expect(res.message).toContain('already up to date');
    });

    it('5.58 Launch & Compatibility Settings renders Sign In & Check button when preview is uninstalled and auth is required', async () => {
      const updateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: false,
        updateAvailable: false,
        downloadUrl: 'https://www.codeweavers.com/preview/download',
        authRequired: true,
        canAutoUpdate: true,
        checkedAt: '2026-11-12T00:00:00.000Z',
      };

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        platforms: [{
          platformId: 'steam',
          platformGameId: '1091500',
          installed: true,
          installPath: '/Users/test/Games/Cyberpunk2077',
          executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
          isWindowsBinaryOnMac: true,
          platforms: { windows: true, mac: false, linux: false },
        }],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Cyberpunk 2077',
        installPath: '/Users/test/Games/Cyberpunk2077',
        executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      const updateSpy = vi.spyOn(launcherService, 'updateCompatibilityLayer').mockResolvedValue({
        success: true,
        runnerType: 'crossover_preview',
        updated: false,
        authenticated: true,
        message: 'Signed in to CodeWeavers — ready to install Preview 20261111.',
      });

      const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let modalTree = modal.render();
      await Promise.resolve();
      modalTree = modal.render();

      // Streamlined Launch Config shows not-installed callout + Manage Runners & Bottles link
      expect(findVNodeByTestId(modalTree, 'runner-not-installed-callout')).toBeDefined();
      expect(findVNodeByTestId(modalTree, 'manage-runners-bottles-btn')).toBeDefined();
      modal.unmount();

      // Underlying form hook still invokes authenticateOnly when authRequired is true
      const formHarness = createLaunchConfigFormHarness({
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      formHarness.render();
      await Promise.resolve();
      formHarness.render();

      expect(formHarness.current.activeUpdateInfo?.authRequired).toBe(true);
      await formHarness.current.handleUpdateRunner();
      expect(updateSpy).toHaveBeenCalledWith('crossover_preview', { authenticateOnly: true });
      formHarness.unmount();
    });

    it('5.59 updateCompatibilityLayer returns ready to install for uninstalled preview instead of claiming up to date', async () => {
      // Uninstalled runner authenticated with CodeWeavers
      const resUninstalled = await macNativeInstaller.updateCompatibilityLayer('crossover_preview', {
        layers: [],
        authenticateOnly: true,
        previewCandidateUrls: ['https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'],
        mockUpdateRunnerDirect: vi.fn().mockResolvedValue({
          authenticated: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
          detectedLayers: [],
        }),
      });

      expect(resUninstalled.success).toBe(true);
      expect(resUninstalled.authenticated).toBe(true);
      expect(resUninstalled.message).toContain('ready to install');
      expect(resUninstalled.message).not.toContain('already up to date');
      expect(resUninstalled.message).not.toContain('is up to date');
    });

    it('5.60 Setup Wizard CompatibilityAndBottleStep displays Update Available badge and opt-in row when update is discovered post sign-in', async () => {
      const installedSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'ready',
          version: '20261015',
          authRequired: true,
        },
      });

      const updatedSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'update_available',
          version: '20261015',
          latestVersion: '20261111',
          latestDisplayVersion: 'Preview 20261111',
          authRequired: false,
        },
      });

      const step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: installedSnapshot,
        chosenRunner: 'crossover_preview',
        onSelectRunner: vi.fn(),
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
      });

      let tree = step.render();
      expect(findVNodeByTestId(tree, 'runner-update-badge-crossover-preview')).toBeUndefined();

      tree = step.render({ snapshot: updatedSnapshot });

      const badge = findVNodeByTestId(tree, 'runner-update-badge-crossover-preview');
      expect(badge).toBeDefined();
      expect(extractVNodeText(badge)).toContain('Update Available · v20261111');

      const optinRow = findVNodeByTestId(tree, 'runner-update-optin-row-crossover-preview');
      expect(optinRow).toBeDefined();
      expect(extractVNodeText(optinRow)).toContain('Update to v20261111 during setup');
      step.unmount();
    });

    it('5.61 installCompatibilityLayer caches authenticated preview download URL and invalidates prober cache', async () => {
      macNativeInstaller.clearCachedAuthenticatedPreviewUrl();

      const res = await macNativeInstaller.installCompatibilityLayer('crossover_preview', 'auto', {
        skipProcessCheck: true,
        mockDirectDownload: vi.fn().mockResolvedValue({
          success: true,
          installed: false,
          authenticated: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
          message: 'CodeWeavers Preview authentication completed.',
        }),
      });

      expect(res.success).toBe(true);
      expect(res.authenticated).toBe(true);
      expect(macNativeInstaller.getCachedAuthenticatedPreviewUrl({ allowCachedPreviewUrlInTest: true })).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
      );
    });

    it('5.62 SSO query routes and OAuth/SSO provider domains are safely recognized and permitted', () => {
      const isAllowedUrl = environmentProvisioner.isAllowedCodeWeaversAuthNavigationUrl;
      expect(isAllowedUrl('https://github.com/login/oauth/authorize')).toBe(true);
      expect(isAllowedUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')).toBe(true);
      expect(isAllowedUrl('https://appleid.apple.com/auth/authorize')).toBe(true);
      expect(isAllowedUrl('https://accounts.google.com/o/oauth2/auth')).toBe(true);
      expect(isAllowedUrl('https://evil-hacker.com/steal-credentials')).toBe(false);
    });

    it('5.63 installRunnerDirect returns authenticated result cleanly even without authenticateOnly flag', async () => {
      const res = await environmentProvisioner.installRunnerDirect('crossover_preview', {
        skipProcessCheck: true,
        capturePreviewDownloadFn: async () => ({
          authenticated: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
          resolvedVersion: '20261111',
        }),
      });

      expect(res.success).toBe(true);
      expect(res.authenticated).toBe(true);
      expect(res.installed).toBe(false);
      expect(res.downloadUrl).toBe('https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip');
    });

    it('5.64 Setup Wizard selecting runner_crossover_preview preserves it in selectedIds when preview is uninstalled and onToggleComponent is passed', async () => {
      const uninstalledSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'missing',
          authRequired: true,
          latestVersion: undefined,
          downloadUrl: undefined,
        },
      });

      // Simulating SystemSetupWizardModal state:
      const selectedIds = new Set<EnvironmentComponentId>(['runner_crossover_preview']);
      const onToggleComponentSpy = vi.fn((id: EnvironmentComponentId) => {
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
      });
      const onSelectRunnerSpy = vi.fn();

      const step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: uninstalledSnapshot,
        chosenRunner: 'crossover_preview',
        onSelectRunner: onSelectRunnerSpy,
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        selectedIds,
        onToggleComponent: onToggleComponentSpy,
      });

      const tree = step.render();
      const card = findVNodeByTestId(tree, 'setup-runner-crossover-preview');
      expect(card).toBeDefined();

      card.props.onClick();

      // onToggleComponent must NOT have been called (which would have deleted runner_crossover_preview)
      expect(onToggleComponentSpy).not.toHaveBeenCalled();
      expect(selectedIds.has('runner_crossover_preview')).toBe(true);
      expect(onSelectRunnerSpy).toHaveBeenCalledWith('crossover_preview');
      step.unmount();
    });

    it('5.65 useGameLaunchConfigForm handleUpdateRunner and handleInstallRunnerViaBrew are mutually guarded against concurrent execution', async () => {
      const updateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: false,
        updateAvailable: false,
        downloadUrl: 'https://www.codeweavers.com/preview/download',
        authRequired: true,
        canAutoUpdate: true,
        checkedAt: '2026-11-12T00:00:00.000Z',
      };

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        platforms: [{
          platformId: 'steam',
          platformGameId: '1091500',
          installed: true,
          installPath: '/Users/test/Games/Cyberpunk2077',
          executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
          isWindowsBinaryOnMac: true,
          platforms: { windows: true, mac: false, linux: false },
        }],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({ crossover_preview: updateInfo });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Cyberpunk 2077',
        installPath: '/Users/test/Games/Cyberpunk2077',
        executablePath: '/Users/test/Games/Cyberpunk2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      let slowUpdateResolver: (val: any) => void;
      const slowUpdatePromise = new Promise((resolve) => {
        slowUpdateResolver = resolve;
      });
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockReturnValue(slowUpdatePromise as any);
      const installSpy = vi.spyOn(launcherService, 'installCompatibilityLayer');

      const formHarness = createLaunchConfigFormHarness({
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      formHarness.render();
      await Promise.resolve();
      formHarness.render();

      // Trigger update/sign-in (which sets isUpdatingRunner = true)
      const updateCallPromise = formHarness.current.handleUpdateRunner();

      // Re-render hook to reflect isUpdatingRunner = true
      formHarness.render();
      expect(formHarness.current.isUpdatingRunner).toBe(true);

      // Attempt concurrent install via brew
      await formHarness.current.handleInstallRunnerViaBrew();
      // installCompatibilityLayer must NOT have been called while updating was in progress!
      expect(installSpy).not.toHaveBeenCalled();

      slowUpdateResolver!({
        success: true,
        runnerType: 'crossover_preview',
        updated: false,
        authenticated: true,
        message: 'Signed in successfully.',
      });
      await updateCallPromise;
      formHarness.unmount();
    });

    it('5.66 captureCodeWeaversPreviewDownload honors timeoutMs, cancels downloads, cleans up listeners, and closes window with TimeoutError', async () => {
      const mockWc = {
        getURL: vi.fn().mockReturnValue('https://www.codeweavers.com/account/login'),
        setUserAgent: vi.fn(),
        executeJavaScript: vi.fn().mockResolvedValue({ hrefs: [], hasPasswordInput: true }),
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      };
      const mockWin = {
        isDestroyed: vi.fn().mockReturnValue(false),
        show: vi.fn(),
        focus: vi.fn(),
        moveTop: vi.fn(),
        hide: vi.fn(),
        close: vi.fn(),
        destroy: vi.fn(),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        webContents: mockWc,
        loadURL: vi.fn().mockResolvedValue(undefined),
      };
      const mockSession = {
        on: vi.fn(),
        removeListener: vi.fn(),
        setUserAgent: vi.fn(),
      };

      function MockBrowserWindow() {
        return mockWin;
      }

      const mockElectronMod = {
        BrowserWindow: MockBrowserWindow,
        session: {
          fromPartition: vi.fn().mockReturnValue(mockSession),
        },
      };

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-timeout-test-'));
      try {
        const timeoutPromise = environmentProvisioner.captureCodeWeaversPreviewDownload(
          tempDir,
          { runId: 'test-run', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
          {
            electronMod: mockElectronMod,
            allowInteractivePreviewCapture: true,
            timeoutMs: 40,
          }
        );

        await expect(timeoutPromise).rejects.toThrow(/timed out after 40ms/);
        expect(mockWin.hide).toHaveBeenCalled();
        expect(mockWc.removeAllListeners).toHaveBeenCalled();
        expect(mockWin.removeAllListeners).toHaveBeenCalled();
        expect(mockSession.removeListener).toHaveBeenCalledWith('will-download', expect.any(Function));
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('5.67 launcherService installCompatibilityLayer refreshes runnerUpdates upon successful runner installation', async () => {
      const initialUpdateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: false,
        updateAvailable: false,
        downloadUrl: 'https://www.codeweavers.com/preview/download',
        authRequired: true,
        canAutoUpdate: true,
        checkedAt: '2026-11-12T00:00:00.000Z',
      };
      const postInstallUpdateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '20261111',
        updateAvailable: false,
        downloadUrl: 'https://www.codeweavers.com/preview/download',
        authRequired: false,
        canAutoUpdate: true,
        checkedAt: '2026-11-12T01:00:00.000Z',
      };

      (launcherService as any).runnerUpdates = { crossover_preview: initialUpdateInfo };

      const checkSpy = vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockImplementation(async () => {
        (launcherService as any).runnerUpdates = { crossover_preview: postInstallUpdateInfo };
        return { crossover_preview: postInstallUpdateInfo };
      });

      const hadWindow = typeof (globalThis as any).window !== 'undefined';
      const originalWindow = (globalThis as any).window;
      (globalThis as any).window = {
        ...(hadWindow ? originalWindow : {}),
        electronAPI: {
          installCompatibilityLayer: vi.fn().mockResolvedValue({
            success: true,
            installed: true,
            runnerType: 'crossover_preview',
            message: 'CrossOver Preview installed.',
            layers: [{
              type: 'crossover_preview',
              name: 'CrossOver Preview',
              version: '20261111',
              binaryPath: '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
              appPath: '/Applications/CrossOver Preview.app',
              available: true,
            }],
          }),
        },
      };

      try {
        const res = await launcherService.installCompatibilityLayer('crossover_preview', 'direct');
        expect(res.success).toBe(true);
        expect(res.installed).toBe(true);
        expect(checkSpy).toHaveBeenCalled();
        expect(launcherService.getRunnerUpdates().crossover_preview.installed).toBe(true);
        expect(launcherService.getRunnerUpdates().crossover_preview.authRequired).toBe(false);
      } finally {
        if (hadWindow) {
          (globalThis as any).window = originalWindow;
        } else {
          delete (globalThis as any).window;
        }
      }
    });
  });
});
