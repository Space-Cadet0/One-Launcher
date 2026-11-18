import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CanonicalGame } from '../src/contracts/game';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  resolveDefaultBottleForLayer,
  type CompatibilityLayerInfo,
  type CompatibilityLayerUpdateInfo,
  type CompatibilityRunnerDescriptor,
  type UpdateCompatibilityLayerResult,
} from '../src/contracts/launcher';
import { resolveEffectiveLaunchPolicy } from '../src/contracts/launchPolicyResolver';
import type {
  EnvironmentComponentId,
  EnvironmentHealthSnapshot,
} from '../src/contracts/environmentSetup';
import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  buildEffectiveLaunchModePreview,
} from '../src/services/launcher/launchPolicyPreview';
import { LauncherService, launcherService } from '../src/services/launcher/launcherService';
import {
  buildProvisioningTasksFromSelection,
  environmentSetupService,
} from '../src/services/launcher/environmentSetupService';
import { CompatibilityLayerSection } from '../src/components/Launcher/LaunchConfig/CompatibilityLayerSection';
import { useGameLaunchConfigForm } from '../src/components/Launcher/LaunchConfig/useGameLaunchConfigForm';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';
import { SystemSetupWizardModal } from '../src/components/Launcher/SystemSetupWizard/SystemSetupWizardModal';
import { isValidBottleNameInput } from '../src/components/Launcher/SystemSetupWizard/steps/CompatibilityAndBottleStep';
import { TopNavBar } from '../src/components/Navigation/TopNavBar';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  findElements,
  getTextContent,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';

const nodeRequire = createRequire(import.meta.url);
const macNativeInstaller = nodeRequire('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const environmentProvisioner = nodeRequire('../electron/launcher/environmentProvisioner.cjs');
const environmentHealthProber = nodeRequire('../electron/launcher/environmentHealthProber.cjs');
const launcherIpcHandlers = nodeRequire('../electron/ipc/launcherIpcHandlers.cjs');
const securityAndPathUtils = nodeRequire('../electron/launcher/securityAndPathUtils.cjs');
const cjsLaunchPolicyResolver = nodeRequire('../electron/launcher/launchPolicyResolver.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

function findVNodes(
  node: unknown,
  predicate: (el: React.ReactElement<any>) => boolean
): React.ReactElement<any>[] {
  const out: React.ReactElement<any>[] = [];
  const visit = (cur: unknown) => {
    if (!cur || typeof cur !== 'object') return;
    if (Array.isArray(cur)) {
      cur.forEach(visit);
      return;
    }
    const el = cur as React.ReactElement<any>;
    if (typeof el.type !== 'undefined') {
      if (predicate(el)) out.push(el);
      if (el.props?.children !== undefined) visit(el.props.children);
    }
  };
  visit(node);
  return out;
}

function findByTestId(
  node: unknown,
  testId: string
): React.ReactElement<any> | undefined {
  return findVNodes(node, (el) => el.props?.['data-testid'] === testId)[0];
}

function makeTempSandbox(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedCrossOverApp(
  appsDir: string,
  opts: { arm64?: boolean; bundleName?: string; version?: string; buildTimestamp?: string } = {}
): { appPath: string; wineBin: string; cxRoot: string } {
  const bundleName =
    opts.bundleName || (opts.arm64 ? 'CrossOver Preview arm64.app' : 'CrossOver Preview.app');
  const appPath = path.join(appsDir, bundleName);
  const cxRoot = path.join(appPath, 'Contents/SharedSupport/CrossOver');
  const binDir = path.join(cxRoot, 'bin');
  const x64Unix = path.join(cxRoot, 'lib/wine/x86_64-unix');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(x64Unix, { recursive: true });
  const wineBin = path.join(binDir, 'wine');
  fs.writeFileSync(wineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'wineserver'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(x64Unix, 'ntdll.so'), 'ELF-X64', 'utf8');
  fs.writeFileSync(path.join(x64Unix, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  if (opts.arm64) {
    const armUnix = path.join(cxRoot, 'lib/wine/aarch64-unix');
    fs.mkdirSync(armUnix, { recursive: true });
    fs.writeFileSync(path.join(armUnix, 'ntdll.so'), 'ELF-ARM64', 'utf8');
    fs.writeFileSync(path.join(armUnix, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'wineserver-arm64'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.codeweavers.CrossOver</string>
<key>CFBundleShortVersionString</key><string>${opts.version || '20261111'}</string>
<key>CFBundleVersion</key><string>27.0.0.41303</string>
</dict></plist>`;
  fs.writeFileSync(path.join(appPath, 'Contents/Info.plist'), plist, 'utf8');

  if (opts.buildTimestamp) {
    const etcDir = path.join(cxRoot, 'etc');
    fs.mkdirSync(etcDir, { recursive: true });
    fs.writeFileSync(
      path.join(etcDir, 'CrossOver.conf'),
      `[CrossOver]\n"BuildTimestamp" = "${opts.buildTimestamp}"\n`,
      'utf8'
    );
  }

  return { appPath, wineBin, cxRoot };
}

function makeLayer(
  type: CompatibilityLayerInfo['type'],
  sandboxRoot: string,
  overrides: Partial<CompatibilityLayerInfo> = {}
): CompatibilityLayerInfo {
  const isArm64 = type === 'crossover_preview_arm64';
  const isPreview = type === 'crossover_preview' || isArm64;
  const appName = isArm64
    ? 'CrossOver Preview arm64.app'
    : isPreview
      ? 'CrossOver Preview.app'
      : 'CrossOver.app';
  const bottlesDir = path.join(sandboxRoot, 'Library/Application Support/CrossOver/Bottles');
  return {
    id: type,
    type,
    name: isArm64
      ? 'CrossOver Preview (Arm64)'
      : isPreview
        ? 'CrossOver Preview'
        : 'CrossOver',
    binaryPath: path.join(sandboxRoot, 'Applications', appName, 'Contents/SharedSupport/CrossOver/bin/wine'),
    appPath: path.join(sandboxRoot, 'Applications', appName),
    bottlesDir,
    availableBottles: [isArm64 ? 'OneLauncher-arm64' : 'OneLauncher'],
    version: isPreview ? '27.0.0' : '26.4.0',
    available: true,
    ...overrides,
  };
}

function makeWizardSnapshot(
  sandboxRoot: string,
  overrides: Partial<EnvironmentHealthSnapshot> = {}
): EnvironmentHealthSnapshot {
  const bottlesDir = path.join(sandboxRoot, 'Library/Application Support/CrossOver/Bottles');
  return {
    probedAt: '2026-11-18T00:00:00.000Z',
    probeDurationMs: 12,
    hostPlatform: 'darwin',
    hostArch: 'arm64',
    isAppleSiliconMac: true,
    hasWriteAccessToSystemApplications: true,
    preferredMacApplicationsDir: path.join(sandboxRoot, 'Applications'),
    connectedStorefronts: [],
    bundledHelpers: {
      gogdlReady: true,
      legendaryReady: true,
      xboxGdkBridgesReady: true,
      metalPreloadReady: true,
    },
    detectedRunners: [],
    clientLogins: {} as EnvironmentHealthSnapshot['clientLogins'],
    localStoreHints: [],
    counts: {
      readyCount: 3,
      missingRecommendedCount: 1,
      removedSinceLastSetupCount: 1,
      pendingClientLoginCount: 0,
      accountMismatchCount: 0,
      updateAvailableCount: 1,
    },
    bottleSummary: {
      runnerType: 'crossover_preview_arm64',
      runnerInstalled: false,
      recommendedBottleName: 'OneLauncher-arm64',
      recommendedBottleMode: 'reuse_existing',
      availableBottles: [
        {
          name: 'OneLauncher',
          path: path.join(bottlesDir, 'OneLauncher'),
          runnerType: 'crossover',
          wineArch: 'win64',
          hasSteam: true,
          hasGogGalaxy: false,
          hasEpicLauncher: false,
          isSandboxed: false,
        },
        {
          name: 'OneLauncher-arm64',
          path: path.join(bottlesDir, 'OneLauncher-arm64'),
          runnerType: 'crossover_preview_arm64',
          wineArch: 'arm64',
          hasSteam: true,
          hasGogGalaxy: false,
          hasEpicLauncher: false,
          isSandboxed: false,
        },
      ],
    },
    components: {
      rosetta2: {
        id: 'rosetta2',
        category: 'os_prerequisite',
        label: 'Rosetta 2',
        description: 'Rosetta 2',
        status: 'ready',
        required: true,
        canAutoInstall: false,
        recommendationTier: 'recommended',
        recommendationBadge: 'Recommended',
        defaultSelected: false,
        whyExplanation: 'Rosetta 2',
        statusDetail: 'Ready',
      },
      runner_crossover: {
        id: 'runner_crossover',
        category: 'compatibility_runner',
        label: 'CrossOver',
        description: 'CrossOver',
        status: 'missing',
        required: false,
        canAutoInstall: true,
        recommendationTier: 'optional',
        recommendationBadge: 'Optional',
        defaultSelected: false,
        whyExplanation: 'CrossOver',
        statusDetail: 'Missing',
      },
      runner_crossover_preview: {
        id: 'runner_crossover_preview',
        category: 'compatibility_runner',
        label: 'CrossOver Preview',
        description: 'CrossOver Preview',
        status: 'update_available',
        required: false,
        canAutoInstall: true,
        recommendationTier: 'optional',
        recommendationBadge: 'Optional',
        defaultSelected: false,
        whyExplanation: 'CrossOver Preview',
        statusDetail: 'Update available',
      },
      runner_crossover_preview_arm64: {
        id: 'runner_crossover_preview_arm64',
        category: 'compatibility_runner',
        label: 'CrossOver Preview (Arm64)',
        description: 'CrossOver Preview (Arm64)',
        status: 'missing',
        wasPreviouslyConfigured: true,
        required: false,
        canAutoInstall: true,
        recommendationTier: 'recommended',
        recommendationBadge: 'Recommended',
        defaultSelected: true,
        whyExplanation: 'CrossOver Preview (Arm64)',
        statusDetail: 'Missing',
      },
      bottle_default: {
        id: 'bottle_default',
        category: 'bottle',
        label: 'CrossOver Bottle',
        description: 'CrossOver Bottle',
        status: 'ready',
        required: true,
        canAutoInstall: true,
        recommendationTier: 'required',
        recommendationBadge: 'Required',
        defaultSelected: false,
        whyExplanation: 'CrossOver Bottle',
        statusDetail: 'Ready',
      },
      bottle_steam: {
        id: 'bottle_steam',
        category: 'bottle_client',
        label: 'Steam (Windows)',
        description: 'Steam in Bottle',
        status: 'ready',
        required: false,
        canAutoInstall: true,
        recommendationTier: 'recommended',
        recommendationBadge: 'Recommended',
        defaultSelected: false,
        whyExplanation: 'Steam in Bottle',
        statusDetail: 'Ready',
      },
    } as unknown as EnvironmentHealthSnapshot['components'],
    ...overrides,
  };
}

describe('M4 Tier 5 Adversarial Hardening Suite', () => {
  const prevElectronApi = (globalThis as unknown as { window?: { electronAPI?: unknown } }).window
    ?.electronAPI;

  beforeEach(() => {
    vi.restoreAllMocks();
    if (typeof localStorage !== 'undefined' && typeof localStorage.clear === 'function') {
      localStorage.clear();
    }
    try {
      macNativeInstaller.clearCachedAuthenticatedPreviewUrl();
      environmentHealthProber.invalidateProberRunnerUpdatesCache();
    } catch {}
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const win = (globalThis as unknown as { window?: { electronAPI?: unknown } }).window;
    if (win) {
      win.electronAPI = prevElectronApi;
    }
  });

  // =========================================================================
  // Part A — Challenger 1 Backend / CJS / IPC / Preload Hardening Tests
  // =========================================================================

  it('C1-T1: updateCompatibilityLayer and installCompatibilityLayer fail cleanly on Intel x64 for crossover_preview_arm64 with 0 external browser opens', async () => {
    const sandbox = makeTempSandbox('ol-t5-c1-f1-');
    try {
      const openExternalSpy = vi.fn();
      const updRes = await macNativeInstaller.updateCompatibilityLayer('crossover_preview_arm64', {
        platform: 'darwin',
        arch: 'x64',
        homedir: sandbox,
        customApplicationsDir: path.join(sandbox, 'Applications'),
        allowDirectVendorInstall: true,
        openExternalFn: openExternalSpy,
      });
      expect(updRes.success).toBe(false);
      expect(updRes.updated).toBe(false);
      expect(String(updRes.error || updRes.message)).toMatch(/Apple Silicon|arm64/i);
      expect(openExternalSpy).not.toHaveBeenCalled();

      const instRes = await macNativeInstaller.installCompatibilityLayer(
        { runnerType: 'crossover_preview_arm64', mode: 'auto' },
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: sandbox,
          customApplicationsDir: path.join(sandbox, 'Applications'),
          allowDirectVendorInstall: true,
          openExternalFn: openExternalSpy,
        }
      );
      expect(instRes.success).toBe(false);
      expect(instRes.installed).toBe(false);
      expect(instRes.openedExternalInstaller).not.toBe(true);
      expect(String(instRes.error || instRes.message)).toMatch(/Apple Silicon|arm64/i);
      expect(openExternalSpy).not.toHaveBeenCalled();

      // Also verify even without allowDirectVendorInstall in test mode it never opens browser
      const instTestModeRes = await macNativeInstaller.installCompatibilityLayer(
        { runnerType: 'crossover_preview_arm64', mode: 'auto' },
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: sandbox,
          customApplicationsDir: path.join(sandbox, 'Applications'),
          openExternalFn: openExternalSpy,
        }
      );
      expect(instTestModeRes.success).toBe(false);
      expect(openExternalSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C1-T2: direct CJS updateCompatibilityLayer, installCompatibilityLayer, and cancelCompatibilityLayerOperation strip leading runner_ prefix', async () => {
    const sandbox = makeTempSandbox('ol-t5-c1-f2-');
    try {
      const openExternalSpy = vi.fn();
      const dlRes = await macNativeInstaller.installCompatibilityLayer(
        { runnerType: 'runner_crossover_preview_arm64', mode: 'download' },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sandbox,
          customApplicationsDir: path.join(sandbox, 'Applications'),
          openExternalFn: openExternalSpy,
        }
      );
      expect(dlRes.success).toBe(true);
      expect(dlRes.runnerType).toBe('crossover_preview_arm64');
      expect(openExternalSpy).toHaveBeenCalledWith('https://www.codeweavers.com/preview/download');

      const mockUpdater = vi.fn().mockResolvedValue({ success: true, updated: false });
      const updRes = await macNativeInstaller.updateCompatibilityLayer(
        { runnerType: 'runner_crossover_preview_arm64' },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sandbox,
          customApplicationsDir: path.join(sandbox, 'Applications'),
          mockUpdater,
        }
      );
      expect(updRes.runnerType).toBe('crossover_preview_arm64');
      expect(mockUpdater).toHaveBeenCalled();

      const cancelRes = macNativeInstaller.cancelCompatibilityLayerOperation(
        'runner_crossover_preview_arm64'
      );
      expect(cancelRes).toEqual({ success: true, cancelled: false });
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C1-T3: startGuidedClientLogin with runnerType auto on darwin x64 rejects unavailable crossover_preview_arm64 instead of falling back to runners[0]', async () => {
    const sandbox = makeTempSandbox('ol-t5-c1-f3-');
    try {
      const appsDir = path.join(sandbox, 'Applications');
      seedCrossOverApp(appsDir, { arm64: true });
      const bottleDir = path.join(
        sandbox,
        'Library/Application Support/CrossOver/Bottles/OneLauncher-arm64'
      );
      const steamExe = path.join(bottleDir, 'drive_c/Program Files (x86)/Steam/steam.exe');
      fs.mkdirSync(path.dirname(steamExe), { recursive: true });
      fs.writeFileSync(steamExe, 'MZ', 'utf8');
      fs.writeFileSync(
        path.join(bottleDir, 'cxbottle.conf'),
        '[Bottle]\n"WineArch" = "arm64"\n"Preview" = "1"\n',
        'utf8'
      );

      const spawnSpy = vi.fn();
      const loginRes = await environmentProvisioner.startGuidedClientLogin(
        {
          targetId: 'bottle_steam',
          runnerType: 'auto',
          bottleName: 'OneLauncher-arm64',
          timeoutMs: 2000,
        },
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: sandbox,
          customApplicationsDir: appsDir,
          spawnClientFn: spawnSpy,
        }
      );
      expect(loginRes.success).toBe(false);
      expect(String(loginRes.error || loginRes.message)).toMatch(/Apple Silicon|arm64/i);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C1-T4: ensureChainedPublisherLauncherInstalled fails fast with missing-runner error even with skipNetwork or provisionChainedLauncherFn', async () => {
    const sandbox = makeTempSandbox('ol-t5-c1-f4-');
    try {
      const appsDir = path.join(sandbox, 'Applications');
      fs.mkdirSync(appsDir, { recursive: true });
      const hookSpy = vi.fn().mockResolvedValue({ installed: true, binaryPath: '/tmp/EA.exe' });

      await expect(
        environmentProvisioner.ensureChainedPublisherLauncherInstalled(
          {
            handoffId: 'ea',
            platform: 'darwin',
            runnerLayer: { type: 'crossover_preview_arm64' },
          },
          {
            platform: 'darwin',
            arch: 'arm64',
            homedir: sandbox,
            customApplicationsDir: appsDir,
            skipNetwork: true,
          }
        )
      ).rejects.toThrow(/Compatibility runner "crossover_preview_arm64" is not installed/i);

      await expect(
        environmentProvisioner.ensureChainedPublisherLauncherInstalled(
          {
            handoffId: 'ea',
            platform: 'darwin',
            runnerLayer: { type: 'crossover_preview_arm64' },
          },
          {
            platform: 'darwin',
            arch: 'arm64',
            homedir: sandbox,
            customApplicationsDir: appsDir,
            provisionChainedLauncherFn: hookSpy,
          }
        )
      ).rejects.toThrow(/Compatibility runner "crossover_preview_arm64" is not installed/i);
      expect(hookSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C1-T5: IPC sanitizeSafeBottleNameSlug rejects leading hyphens and FORBIDDEN_RENDERER_IPC_KEYS strips test/DI override options', () => {
    expect(launcherIpcHandlers.sanitizeSafeBottleNameSlug('-evil')).toBeNull();
    expect(launcherIpcHandlers.sanitizeSafeBottleNameSlug('--flag')).toBeNull();
    expect(launcherIpcHandlers.sanitizeSafeBottleNameSlug('OneLauncher-arm64')).toBe(
      'OneLauncher-arm64'
    );

    expect(
      launcherIpcHandlers.sanitizeSetupWizardStatePatch({ preferredBottleName: '--evil' })
        .preferredBottleName
    ).toBeUndefined();
    expect(
      launcherIpcHandlers.sanitizeEnvironmentSetupTasksPayload({
        tasks: [{ action: 'ensure_bottle', componentId: 'bottle_default', bottleName: '-evil' }],
      }).ok
    ).toBe(false);
    expect(
      launcherIpcHandlers.sanitizeGuidedClientLoginPayload({
        targetId: 'bottle_steam',
        bottleName: '-evil',
      }).ok
    ).toBe(false);

    const dirtyOpts: Record<string, unknown> = {
      customApplicationsDir: '/tmp/evil-apps',
      applicationsDirs: ['/tmp/evil-apps'],
      arch: 'x64',
      platform: 'win32',
      allowLoopbackInstallerUrls: true,
      mockFeeds: {},
      previewPortalHtml: '<html></html>',
      previewCandidateUrls: ['https://example.invalid/a.zip'],
      fetchFn: () => null,
      httpGetText: () => '',
      previewSessionFetch: () => null,
      sessionFetch: () => null,
      mockDirectDownload: () => null,
      capturePreviewDownloadFn: () => null,
      onExtractArchive: () => null,
      onExecDitto: () => null,
      onExecHdiutil: () => null,
      onExecBrew: () => null,
      verifySignatureFn: () => null,
      electronMod: {},
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      skipBottleProvisioning: true,
      skipNetwork: true,
      forceRefresh: true,
    };
    for (const key of Object.keys(dirtyOpts)) {
      if (key !== 'forceRefresh') {
        expect(securityAndPathUtils.FORBIDDEN_RENDERER_IPC_KEYS.has(key)).toBe(true);
      }
    }
    const sanitized = launcherIpcHandlers.sanitizeRendererIpcOptions(dirtyOpts);
    expect(Object.keys(sanitized)).toEqual(['forceRefresh']);
  });

  it('C1-T6: space-delimited %20arm64- Preview URLs classify as arm64 and are excluded from standard in both CJS modules', async () => {
    const spaceArm64Url =
      'https://www.codeweavers.com/preview/download/crossover-preview%20arm64-20261111.zip';
    const stdUrl =
      'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip';

    expect(
      environmentProvisioner.classifyCrossOverPreviewArchiveBranch(spaceArm64Url)
    ).toBe('arm64');
    expect(
      environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl([spaceArm64Url], undefined, {
        previewBranch: 'standard',
      })
    ).toBeNull();
    expect(
      environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl([spaceArm64Url], undefined, {
        previewBranch: 'arm64',
      })
    ).toBe(spaceArm64Url);
    expect(
      environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
        [spaceArm64Url, stdUrl],
        undefined,
        { previewBranch: 'standard' }
      )
    ).toBe(stdUrl);

    // Also verify macNativeInstallerAndCodesign.cjs classifyPreviewBranchFromTarget via checkCompatibilityLayerUpdates
    const sandbox = makeTempSandbox('ol-t5-c1-f6-');
    try {
      const appsDir = path.join(sandbox, 'Applications');
      seedCrossOverApp(appsDir, { arm64: false, version: '20261101' });
      seedCrossOverApp(appsDir, { arm64: true, version: '20261101' });
      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox,
        customApplicationsDir: appsDir,
        previewCandidateUrls: [spaceArm64Url],
      });
      expect(updates.crossover_preview?.downloadUrl).toBeUndefined();
      expect(updates.crossover_preview_arm64?.downloadUrl).toBe(spaceArm64Url);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C1-T7: updateCompatibilityLayer with switchToStableCrossOver targets only CrossOver.app busy state and is not blocked by running CrossOver Preview.app', async () => {
    const sandbox = makeTempSandbox('ol-t5-c1-f7-');
    try {
      const appsDir = path.join(sandbox, 'Applications');
      const preview = seedCrossOverApp(appsDir, { arm64: false, version: '26.2.0' });

      const previewLayer = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: preview.appPath,
        binaryPath: preview.wineBin,
        version: '26.2.0',
        available: true,
      };

      const stable = seedCrossOverApp(appsDir, {
        arm64: false,
        bundleName: 'CrossOver.app',
        version: '26.4.0',
      });

      const res = await macNativeInstaller.updateCompatibilityLayer(
        { runnerType: 'crossover_preview', switchToStableCrossOver: true },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sandbox,
          customApplicationsDir: appsDir,
          layers: [previewLayer],
          getProcessListOutput: async () =>
            `12345 ${preview.appPath}/Contents/MacOS/CrossOver Preview\n`,
          mockDirectDownload: async () => ({
            success: true,
            installed: true,
            switchedToStableCrossOver: true,
            installedPath: stable.appPath,
            version: '26.4.0',
          }),
        }
      );
      expect(res.busyCode).toBeUndefined();
      expect(res.success).toBe(true);

      // Direct installRunnerDirect with switchToStableCrossOver also ignores running Preview PID
      const directRes = await environmentProvisioner.installRunnerDirect('crossover_preview', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox,
        customApplicationsDir: appsDir,
        existingLayer: previewLayer,
        switchToStableCrossOver: true,
        getProcessListOutput: async () =>
          `12345 ${preview.appPath}/Contents/MacOS/CrossOver Preview\n`,
        mockDirectDownload: async () => ({
          success: true,
          installed: true,
          switchedToStableCrossOver: true,
          installedPath: stable.appPath,
          version: '26.4.0',
        }),
      });
      expect(directRes.success).toBe(true);

      // Conversely, running CrossOver.app itself MUST block switchToStableCrossOver
      const stableLayer = {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        appPath: stable.appPath,
        binaryPath: stable.wineBin,
        version: '26.4.0',
        available: true,
      };
      const blockedByStable = await macNativeInstaller.updateCompatibilityLayer(
        { runnerType: 'crossover_preview', switchToStableCrossOver: true },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sandbox,
          customApplicationsDir: appsDir,
          layers: [previewLayer, stableLayer],
          getProcessListOutput: async () =>
            `12346 ${stable.appPath}/Contents/MacOS/CrossOver\n`,
          mockDirectDownload: async () => ({ success: true, installed: true }),
        }
      );
      expect(blockedByStable.success).toBe(false);
      expect(blockedByStable.busyCode).toBe('RUNNER_BUSY_EXTERNAL_PROCESS');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C1-T8: runEnvironmentSetupTasks preserves sibling-branch cached authenticated preview URLs', async () => {
    const sandbox = makeTempSandbox('ol-t5-c1-f8-');
    try {
      const appsDir = path.join(sandbox, 'Applications');
      seedCrossOverApp(appsDir, { arm64: false, version: '20261111' });
      const armUrl =
        'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip';
      macNativeInstaller.setCachedAuthenticatedPreviewUrl(armUrl, { previewBranch: 'arm64' });

      await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [{ action: 'install_runner', componentId: 'runner_crossover_preview' }],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sandbox,
          userDataDir: path.join(sandbox, 'userData'),
          customApplicationsDir: appsDir,
        }
      );

      expect(
        macNativeInstaller.getCachedAuthenticatedPreviewUrl({
          previewBranch: 'arm64',
          allowCachedPreviewUrlInTest: true,
        })
      ).toBe(armUrl);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C1-T9: inspectBottleConfMetadata handles UTF-8 BOM + inline header comments and resolveWineserverBinary detects custom arm64 bundles without breaking win64 Rosetta routing', () => {
    const sandbox = makeTempSandbox('ol-t5-c1-f9-');
    try {
      const bottleBom = path.join(sandbox, 'bottle-bom');
      fs.mkdirSync(bottleBom, { recursive: true });
      fs.writeFileSync(
        path.join(bottleBom, 'cxbottle.conf'),
        '\uFEFF[Bottle] ; header comment\r\n"WineArch" = "arm64"\r\n"Preview" = "1"\r\n',
        'utf8'
      );
      expect(macNativeInstaller.inspectBottleConfMetadata(bottleBom)).toEqual({
        wineArch: 'arm64',
        previewEnabled: true,
      });

      const bottleHash = path.join(sandbox, 'bottle-hash');
      fs.mkdirSync(bottleHash, { recursive: true });
      fs.writeFileSync(
        path.join(bottleHash, 'cxbottle.conf'),
        '[Bottle] # hash comment\n"WineArch" = "win64"\n',
        'utf8'
      );
      expect(macNativeInstaller.inspectBottleConfMetadata(bottleHash)).toEqual({
        wineArch: 'win64',
      });

      const appsDir = path.join(sandbox, 'Applications');
      const custom = seedCrossOverApp(appsDir, {
        arm64: true,
        bundleName: 'CrossOver-Custom.app',
      });
      // Omitted options on custom arm64 bundle -> wineserver-arm64
      expect(path.basename(macNativeInstaller.resolveWineserverBinary(custom.wineBin) || '')).toBe(
        'wineserver-arm64'
      );
      // Explicit win64 / Rosetta routing -> wineserver
      expect(
        path.basename(
          macNativeInstaller.resolveWineserverBinary(custom.wineBin, { wineArch: 'win64' }) || ''
        )
      ).toBe('wineserver');
      expect(
        path.basename(
          macNativeInstaller.resolveWineserverBinary(custom.wineBin, { bottlePath: bottleHash }) ||
            ''
        )
      ).toBe('wineserver');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Part B — Challenger 2 Contracts, Preload, Services, UI, WCAG & Portability
  // =========================================================================

  it('C2-T1: shared multi-arch availableBottles ordering resolves OneLauncher-arm64 across helper, launchPolicyPreview, useGameLaunchConfigForm, and CompatibilityLayerSection', async () => {
    const sandbox = makeTempSandbox('ol-t5-c2-f1-');
    try {
      const armLayer = makeLayer('crossover_preview_arm64', sandbox, {
        availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64', previewEnabled: true },
          'OneLauncher-arm64': { wineArch: 'arm64', previewEnabled: true },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 't5-c2-f1-game',
        title: 'Multi-Arch Bottle Game',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '991001',
            installed: true,
            installPath: path.join(sandbox, 'games/MultiArch'),
            executablePath: path.join(sandbox, 'games/MultiArch/game.exe'),
          },
        ],
      });

      expect(
        resolveDefaultBottleForLayer(armLayer, 'crossover_preview_arm64', 'OneLauncher-arm64')
      ).toBe('OneLauncher-arm64');

      const preview = buildEffectiveLaunchModePreview({
        game,
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        preferredPlatformId: 'steam',
        savedConfig: {
          gameId: game.id,
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
        },
        layers: [armLayer],
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
      });
      expect(preview.autoResolvedSummary).toContain('Bottle: "OneLauncher-arm64"');

      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([armLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([armLayer]);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
      });

      let latestForm: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const Harness: React.FC = () => {
        const form = useGameLaunchConfigForm({
          isOpen: true,
          game,
          initialPlatformId: 'steam',
          onClose: vi.fn(),
        });
        latestForm = form;
        return React.createElement(CompatibilityLayerSection, {
          isWindowsHost: form.isWindowsHost,
          preview: form.preview,
          activeDisplayMethod: form.activeDisplayMethod,
          detectedLayers: form.detectedLayers,
          runnerUpdates: form.runnerUpdates,
          compatibilityLayer: form.compatibilityLayer,
          onSelectCompatibilityLayer: form.handleSelectCompatibilityLayer,
          availableBottles: form.availableBottles,
          wineBottleName: form.wineBottleName,
          onChangeWineBottleName: form.setWineBottleName,
          selectedRunnerDescriptor: form.selectedRunnerDescriptor,
          activeLayer: form.activeLayer,
          activeUpdateInfo: form.activeUpdateInfo,
          activeInstalledVer: form.activeInstalledVer,
          activeSecondaryBuildText: form.activeSecondaryBuildText,
          activeRunnerProgress: form.activeRunnerProgress,
          isCheckingUpdates: form.isCheckingUpdates,
          isUpdatingRunner: form.isUpdatingRunner,
          onUpdateRunner: form.handleUpdateRunner,
          onCheckRunnerUpdates: form.handleCheckRunnerUpdates,
          resolvedBottleFolderPath: form.resolvedBottleFolderPath,
          onOpenBottleFolder: form.handleOpenBottleFolder,
          isRescanningRunners: form.isRescanningRunners,
          onRescanLayers: form.handleRescanLayers,
          isInstallingRunner: form.isInstallingRunner,
          onInstallRunnerViaBrew: form.handleInstallRunnerViaBrew,
          onDownloadRunner: form.handleDownloadRunner,
          runnerUpdateFeedback: form.runnerUpdateFeedback,
          runnerActionFeedback: form.runnerActionFeedback,
          winePrefixPath: form.winePrefixPath,
          onChangeWinePrefixPath: form.setWinePrefixPath,
          onBrowseWinePrefix: form.handleBrowseWinePrefix,
          crossoverGraphicsBackend: form.crossoverGraphicsBackend,
          onChangeCrossoverGraphicsBackend: form.setCrossoverGraphicsBackend,
          crossoverD3DMetalVersion: form.crossoverD3DMetalVersion,
          onChangeCrossoverD3DMetalVersion: form.setCrossoverD3DMetalVersion,
          showD3DMetalVersionSelector: form.showD3DMetalVersionSelector,
          primaryD3DVer: form.primaryD3DVer,
          fallbackD3DVer: form.fallbackD3DVer,
          onChangeCrossoverHighResolutionMode: form.setCrossoverHighResolutionMode,
          isDlssSupportedBackend: form.isDlssSupportedBackend,
          isDxvkHudSupported: form.isDxvkHudSupported,
          crossoverDlss: form.crossoverDlss,
          onToggleCrossoverDlss: form.handleToggleCrossoverDlss,
          wineMsync: form.wineMsync,
          onToggleWineMsync: form.handleToggleWineMsync,
          wineEsync: form.wineEsync,
          onToggleWineEsync: form.handleToggleWineEsync,
          metalHud: form.metalHud,
          onToggleMetalHud: form.handleToggleMetalHud,
          dxvkHud: form.dxvkHud,
          onToggleDxvkHud: form.handleToggleDxvkHud,
        });
      };

      const renderer = createDomain12DeepRenderer(Harness, {});
      renderer.render();
      await Promise.resolve();
      const tree = renderer.render();
      expect(latestForm!.resolvedBottleFolderPath).toBe(
        path.join(armLayer.bottlesDir!, 'OneLauncher-arm64')
      );
      const bottleSel = findVNodes(
        tree,
        (el) => el.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(getTextContent(bottleSel)).toContain('Default Bottle (OneLauncher-arm64)');
      renderer.unmount();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C2-T2: preload.cjs exposes arch matching ElectronAPI and LauncherService notifies subscribers when initialize() resolves detectedHostArch', async () => {
    const preloadSrc = fs.readFileSync(path.join(REPO_ROOT, 'electron/preload.cjs'), 'utf8');
    const dtsSrc = fs.readFileSync(path.join(REPO_ROOT, 'src/types/electron.d.ts'), 'utf8');
    expect(preloadSrc).toMatch(/arch:\s*process\.arch/);
    expect(dtsSrc).toMatch(/readonly\s+arch\?:\s*string;/);

    const svc = new LauncherService();
    const winObj = globalThis as unknown as {
      window?: { electronAPI?: Record<string, unknown>; addEventListener?: unknown; removeEventListener?: unknown; dispatchEvent?: unknown };
    };
    const hadWindow = Boolean(winObj.window);
    if (!winObj.window) {
      winObj.window = {};
    }
    winObj.window.electronAPI = {
      isElectron: true,
      platform: 'darwin',
      getAppInfo: vi.fn().mockResolvedValue({ version: '0.2.7', platform: 'darwin', arch: 'x64' }),
      scanAllInstalledGames: vi.fn().mockResolvedValue({ success: true, installedGames: [] }),
    };

    const origNav = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { platform: 'MacIntel', userAgent: 'Mozilla/5.0', userAgentData: { architecture: 'x86' } },
    });
    try {
      expect(svc.getHostArch()).toBe('x64');
      let notifications = 0;
      const unsub = svc.subscribe(() => {
        notifications += 1;
      });
      await svc.initialize();
      unsub();
      expect(svc.getHostArch()).toBe('x64');
      expect(notifications).toBeGreaterThanOrEqual(1);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: origNav,
      });
      if (!hadWindow) {
        delete winObj.window;
      }
    }
  });

  it('C2-T3: buildEffectiveLaunchModePreview sanitizes persisted crossover_preview_arm64 on Intel x64 so arm64/FEX is never advertised', () => {
    const sandbox = makeTempSandbox('ol-t5-c2-f3-');
    try {
      const crossoverLayer = makeLayer('crossover', sandbox);
      const previewLayer = makeLayer('crossover_preview', sandbox);
      const game = makeCanonicalGameFixture({
        id: 't5-c2-f3-game',
        title: 'Intel Sanitized Game',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '992001',
            installed: true,
            installPath: path.join(sandbox, 'games/IntelSan'),
            executablePath: path.join(sandbox, 'games/IntelSan/game.exe'),
          },
        ],
      });

      const preview = buildEffectiveLaunchModePreview({
        game,
        hostPlatform: 'darwin',
        hostArch: 'x64',
        preferredPlatformId: 'steam',
        savedConfig: {
          gameId: game.id,
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
          wineBottleName: 'OneLauncher-arm64',
        },
        layers: [crossoverLayer, previewLayer],
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
      });
      expect(preview.autoResolvedSummary).not.toContain('arm64 / FEX');
      expect(preview.autoResolvedSummary).not.toContain('OneLauncher-arm64');
      expect(preview.autoResolvedSummary).toContain('CrossOver Preview');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C2-T4: GameInstallModal blocks Start Download & Install when saved bottle has arch mismatch, wires aria-describedby, uses focus-visible ring, and defaults empty layers to OneLauncher', async () => {
    const sandbox = makeTempSandbox('ol-t5-c2-f4-');
    try {
      const armLayer = makeLayer('crossover_preview_arm64', sandbox, {
        availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64', previewEnabled: true },
          'OneLauncher-arm64': { wineArch: 'arm64', previewEnabled: true },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 't5-c2-f4-game',
        title: 'Mismatch Install Game',
        platforms: [{ platformId: 'gog', platformGameId: '993001', installed: false }],
      });

      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([armLayer]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher',
      });
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined);
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'gog',
        platformGameId: '993001',
        defaultInstallDir: path.join(sandbox, 'Games/Mismatch'),
        availableInstallDirs: [path.join(sandbox, 'Games/Mismatch')],
        canDirectDownload: true,
        estimatedSizeBytes: 1024,
        availableInstallers: [
          { id: 'gog_win', name: 'Windows Installer', os: 'windows', totalSizeBytes: 1024 },
        ],
        diskSpace: {
          targetPath: path.join(sandbox, 'Games/Mismatch'),
          freeBytes: 100_000_000_000,
          usedBytes: 100_000_000_000,
          totalBytes: 200_000_000_000,
        },
      });

      const renderer = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'gog',
        onClose: vi.fn(),
      });
      renderer.render();
      await Promise.resolve();
      await Promise.resolve();
      const tree = renderer.render();

      const warnEl = findByTestId(tree, 'preinstall-bottle-arch-warning');
      expect(warnEl).toBeDefined();
      expect(warnEl!.props.id).toBe('preinstall-bottle-arch-warning');

      const startBtn = findVNodes(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
      )[0];
      expect(startBtn.props.disabled).toBe(true);
      expect(startBtn.props['aria-describedby']).toBe('preinstall-bottle-arch-warning');
      await startBtn.props.onClick();
      expect(saveSpy).not.toHaveBeenCalled();

      // Checkboxes must use focus-visible:ring-2 rather than focus:ring-0
      const checkboxes = findVNodes(
        tree,
        (el) => el.type === 'input' && el.props?.type === 'checkbox'
      );
      expect(checkboxes.length).toBeGreaterThanOrEqual(2);
      for (const cb of checkboxes) {
        expect(String(cb.props.className || '')).not.toContain('focus:ring-0');
        expect(String(cb.props.className || '')).toContain('focus-visible:ring-2');
      }
      renderer.unmount();

      // Empty compatLayers Steam Windows build defaults bottle path to OneLauncher (not Steam)
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      const steamGame = makeCanonicalGameFixture({
        id: 't5-c2-f4-steam',
        title: 'Steam Empty Layers Game',
        platforms: [{ platformId: 'steam', platformGameId: '993002', installed: false }],
      });
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '993002',
        defaultInstallDir: '~/Library/Application Support/CrossOver/Bottles/OneLauncher',
        availableInstallDirs: [],
        canDirectDownload: true,
        estimatedSizeBytes: 1024,
        availableInstallers: [
          { id: 'steam_win', name: 'Windows Build', os: 'windows', totalSizeBytes: 1024 },
        ],
        diskSpace: {
          targetPath: path.join(sandbox, 'Games/Mismatch'),
          freeBytes: 100_000_000_000,
          usedBytes: 100_000_000_000,
          totalBytes: 200_000_000_000,
        },
      });
      const steamRenderer = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game: steamGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      steamRenderer.render();
      await Promise.resolve();
      await Promise.resolve();
      const steamTree = steamRenderer.render();
      const steamDisplay = findByTestId(steamTree, 'steam-library-location-display');
      const steamDisplayText = getTextContent(steamDisplay);
      expect(steamDisplayText).toContain('/Bottles/OneLauncher/drive_c/');
      expect(steamDisplayText).toContain('CrossOver / Wine Bottle Steam Library (OneLauncher)');
      steamRenderer.unmount();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C2-T5: switching runner dropdown mid-flight still cancels the originally started runner operation', async () => {
    const sandbox = makeTempSandbox('ol-t5-c2-f5-');
    try {
      const armLayer = makeLayer('crossover_preview_arm64', sandbox);
      const cxLayer = makeLayer('crossover', sandbox);
      const game = makeCanonicalGameFixture({
        id: 't5-c2-f5-game',
        title: 'Midflight Cancel Game',
        platforms: [{ platformId: 'steam', platformGameId: '994001', installed: true }],
      });

      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([armLayer, cxLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([armLayer, cxLayer]);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
      });

      const resolveHolder: { fn: ((v: UpdateCompatibilityLayerResult) => void) | null } = {
        fn: null,
      };
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(
        () =>
          new Promise<UpdateCompatibilityLayerResult>((resolve) => {
            resolveHolder.fn = resolve;
          })
      );
      const cancelSpy = vi
        .spyOn(launcherService, 'cancelCompatibilityLayerOperation')
        .mockResolvedValue({ success: true, cancelled: true });

      let latestForm: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const Harness: React.FC = () => {
        latestForm = useGameLaunchConfigForm({
          isOpen: true,
          game,
          initialPlatformId: 'steam',
          onClose: vi.fn(),
        });
        return React.createElement('div');
      };

      const renderer = createDomain12DeepRenderer(Harness, {});
      renderer.render();
      await Promise.resolve();
      renderer.render();

      const updatePromise = latestForm!.handleUpdateRunner();
      renderer.render();
      // Switch dropdown mid-flight to 'crossover'
      latestForm!.handleSelectCompatibilityLayer('crossover');
      renderer.render();

      await latestForm!.handleCancelRunnerOperation();
      expect(cancelSpy).toHaveBeenCalledWith('crossover_preview_arm64');

      resolveHolder.fn?.({
        success: false,
        cancelled: true,
        runnerType: 'crossover_preview_arm64',
        updated: false,
        message: 'Cancelled',
      });
      await updatePromise;
      renderer.unmount();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C2-T6: Wizard runnerUpdateOptInIds does not queue stale runner_crossover_preview update after switching to crossover_preview_arm64 or skip', () => {
    const sandbox = makeTempSandbox('ol-t5-c2-f6-');
    try {
      const snapshot = makeWizardSnapshot(sandbox);
      const tasksArm = buildProvisioningTasksFromSelection({
        snapshot,
        chosenRunner: 'crossover_preview_arm64',
        selectedIds: new Set<EnvironmentComponentId>([
          'runner_crossover_preview_arm64',
          'bottle_default',
        ]),
        bottleName: 'OneLauncher-arm64',
        bottleMode: 'reuse_existing',
        runnerUpdateOptInIds: new Set<EnvironmentComponentId>(['runner_crossover_preview']),
      });
      expect(tasksArm.some((t) => t.componentId === 'runner_crossover_preview')).toBe(false);
      expect(tasksArm.some((t) => t.componentId === 'runner_crossover_preview_arm64')).toBe(true);

      const tasksSkip = buildProvisioningTasksFromSelection({
        snapshot,
        chosenRunner: 'skip',
        selectedIds: new Set<EnvironmentComponentId>(),
        bottleName: 'OneLauncher',
        bottleMode: 'reuse_existing',
        runnerUpdateOptInIds: new Set<EnvironmentComponentId>(['runner_crossover_preview']),
      });
      expect(tasksSkip).toEqual([]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C2-T7: SystemSetupWizardModal Reinstall Missing from skip syncs chosenRunnerRef and bottleName to OneLauncher-arm64', async () => {
    const sandbox = makeTempSandbox('ol-t5-c2-f7-');
    try {
      const snapshot = makeWizardSnapshot(sandbox, {
        bottleSummary: {
          runnerType: 'crossover',
          runnerInstalled: true,
          recommendedBottleName: 'OneLauncher',
          recommendedBottleMode: 'reuse_existing',
          availableBottles: [
            {
              name: 'OneLauncher',
              path: path.join(sandbox, 'Library/Application Support/CrossOver/Bottles/OneLauncher'),
              runnerType: 'crossover',
              wineArch: 'win64',
              hasSteam: false,
              hasGogGalaxy: false,
              hasEpicLauncher: false,
              isSandboxed: false,
            },
          ],
        },
      });
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(snapshot);
      vi.spyOn(environmentSetupService, 'probeHealth').mockResolvedValue(snapshot);
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue({
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        preferredRunnerType: 'skip',
        preferredBottleName: 'OneLauncher',
        configuredComponents: ['runner_crossover_preview_arm64'],
      });
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');

      const renderer = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        connectedStorefronts: [],
        onClose: vi.fn(),
      });
      renderer.render();
      await Promise.resolve();
      await Promise.resolve();
      let tree = renderer.render();

      const repairBtn = findByTestId(tree, 'repair-removed-components-btn');
      expect(repairBtn).toBeDefined();
      repairBtn!.props.onClick();
      tree = renderer.render();

      // Navigate back to compatibility step to inspect synced bottleName input
      const compatTab = findByTestId(tree, 'setup-step-tab-compatibility');
      compatTab!.props.onClick();
      tree = renderer.render();

      const bottleInput = findByTestId(tree, 'setup-bottle-name-input');
      expect(bottleInput?.props?.value).toBe('OneLauncher-arm64');
      renderer.unmount();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C2-T8: launchPolicyResolver.ts and launchPolicyResolver.cjs match 1:1 including isClientlessXboxInstall', () => {
    const cases: Array<Record<string, unknown>> = [
      {
        platformId: 'xbox',
        hostPlatform: 'win32',
        isInstalled: true,
        isClientlessXboxInstall: true,
        configuredLaunchMethod: 'auto',
        globalStorefrontLifecycle: 'default_client',
      },
      {
        platformId: 'xbox',
        hostPlatform: 'win32',
        isInstalled: true,
        isClientlessXboxInstall: false,
        configuredLaunchMethod: 'auto',
        globalStorefrontLifecycle: 'default_client',
      },
      {
        platformId: 'xbox',
        hostPlatform: 'darwin',
        isInstalled: true,
        isWindowsBinaryOnMac: true,
        isClientlessXboxInstall: true,
        configuredLaunchMethod: 'auto',
      },
      {
        platformId: 'steam',
        hostPlatform: 'darwin',
        isInstalled: true,
        isWindowsBinaryOnMac: true,
        configuredLaunchMethod: 'direct',
      },
    ];

    for (const input of cases) {
      const tsOut = resolveEffectiveLaunchPolicy(input);
      const cjsOut = cjsLaunchPolicyResolver.resolveEffectiveLaunchPolicy(input);
      expect(tsOut).toEqual(cjsOut);
    }
  });

  it('C2-T9: handleSave catches rejections into accessible saveError alert, feedback banners use WCAG live roles, and switch/archive buttons invoke handlers', async () => {
    const sandbox = makeTempSandbox('ol-t5-c2-f9-');
    try {
      const previewLayer = makeLayer('crossover_preview', sandbox);
      const game = makeCanonicalGameFixture({
        id: 't5-c2-f9-game',
        title: 'Save Error & WCAG Game',
        platforms: [{ platformId: 'steam', platformGameId: '995001', installed: true }],
      });

      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([previewLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([previewLayer]);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview',
      });
      vi.spyOn(launcherService, 'saveLaunchConfig').mockRejectedValue(
        new Error('Disk quota exceeded during save')
      );

      const modalRenderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      modalRenderer.render();
      await Promise.resolve();
      let modalTree = modalRenderer.render();

      const saveBtn = findElements(
        modalTree,
        (el) => el.type === 'button' && getTextContent(el).includes('Save Configuration')
      )[0];
      await expect(saveBtn.props.onClick()).resolves.toBeUndefined();
      modalTree = modalRenderer.render();

      const saveErrorBanner = findByTestId(modalTree, 'launch-config-save-error');
      expect(saveErrorBanner).toBeDefined();
      expect(saveErrorBanner!.props.role).toBe('alert');
      expect(getTextContent(saveErrorBanner)).toContain('Disk quota exceeded during save');
      modalRenderer.unmount();

      // Verify CompatibilityLayerSection feedback live roles + switch/archive button wiring
      const switchSpy = vi.fn();
      const archiveSpy = vi.fn();
      const baseDescriptor = COMPATIBILITY_RUNNER_DESCRIPTORS.find(
        (d) => d.type === 'crossover_preview'
      )!;
      const nonAutoDescriptor: CompatibilityRunnerDescriptor = {
        ...baseDescriptor,
        canAutoInstallDirect: false,
        canAutoInstallViaBrew: false,
      };
      const basePreview = buildEffectiveLaunchModePreview({
        game,
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        preferredPlatformId: 'steam',
        savedConfig: {
          gameId: game.id,
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview',
        },
        layers: [previewLayer],
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
      });

      const sectionWithSwitch = React.createElement(CompatibilityLayerSection, {
        isWindowsHost: false,
        preview: basePreview,
        activeDisplayMethod: 'compatibility_layer',
        detectedLayers: [previewLayer],
        runnerUpdates: {
          crossover_preview: {
            runnerType: 'crossover_preview',
            installed: true,
            installedVersion: '26.2.0',
            latestVersion: '26.4.0',
            updateAvailable: false,
            canAutoUpdate: false,
            stableSurpassesPreview: true,
            stableFallbackVersion: '26.4.0',
            checkedAt: '2026-11-18T00:00:00.000Z',
          } satisfies CompatibilityLayerUpdateInfo,
        },
        compatibilityLayer: 'crossover_preview',
        onSelectCompatibilityLayer: vi.fn(),
        availableBottles: ['OneLauncher'],
        wineBottleName: '',
        onChangeWineBottleName: vi.fn(),
        selectedRunnerDescriptor: baseDescriptor,
        activeLayer: previewLayer,
        activeUpdateInfo: {
          runnerType: 'crossover_preview',
          installed: true,
          installedVersion: '26.2.0',
          latestVersion: '26.4.0',
          updateAvailable: false,
          canAutoUpdate: false,
          stableSurpassesPreview: true,
          stableFallbackVersion: '26.4.0',
          checkedAt: '2026-11-18T00:00:00.000Z',
        },
        activeInstalledVer: '26.2.0',
        activeSecondaryBuildText: '',
        isCheckingUpdates: false,
        isUpdatingRunner: false,
        onUpdateRunner: vi.fn(),
        onCheckRunnerUpdates: vi.fn(),
        onSwitchToStableCrossOver: switchSpy,
        onInstallRunnerFromArchive: archiveSpy,
        onOpenBottleFolder: vi.fn(),
        isRescanningRunners: false,
        onRescanLayers: vi.fn(),
        isInstallingRunner: false,
        onInstallRunnerViaBrew: vi.fn(),
        onDownloadRunner: vi.fn(),
        runnerUpdateFeedback: 'Could not reach update server.',
        runnerActionFeedback: { tone: 'amber', text: 'Operation failed.' },
        winePrefixPath: '',
        onChangeWinePrefixPath: vi.fn(),
        onBrowseWinePrefix: vi.fn(),
        crossoverGraphicsBackend: 'auto',
        onChangeCrossoverGraphicsBackend: vi.fn(),
        crossoverD3DMetalVersion: 'auto',
        onChangeCrossoverD3DMetalVersion: vi.fn(),
        showD3DMetalVersionSelector: false,
        primaryD3DVer: '4.0b3',
        fallbackD3DVer: '3.0',
        onChangeCrossoverHighResolutionMode: vi.fn(),
        isDlssSupportedBackend: false,
        isDxvkHudSupported: false,
        crossoverDlss: false,
        onToggleCrossoverDlss: vi.fn(),
        wineMsync: true,
        onToggleWineMsync: vi.fn(),
        wineEsync: false,
        onToggleWineEsync: vi.fn(),
        metalHud: false,
        onToggleMetalHud: vi.fn(),
        dxvkHud: false,
        onToggleDxvkHud: vi.fn(),
      });
      const switchRenderer = createDomain12DeepRenderer(() => sectionWithSwitch, {});
      const switchTree = switchRenderer.render();
      const switchBtn = findByTestId(switchTree, 'switch-to-stable-crossover-btn');
      expect(switchBtn).toBeDefined();
      switchBtn!.props.onClick();
      expect(switchSpy).toHaveBeenCalledTimes(1);

      const updFeedback = findByTestId(switchTree, 'runner-update-feedback');
      expect(updFeedback?.props.role).toBe('alert');
      expect(updFeedback?.props['aria-live']).toBe('assertive');

      const actFeedback = findByTestId(switchTree, 'runner-action-feedback');
      expect(actFeedback?.props.role).toBe('alert');
      expect(actFeedback?.props['aria-live']).toBe('assertive');
      switchRenderer.unmount();

      // Archive button renders & fires when !canAutoInstallRunner and runner not installed
      const archiveSection = React.createElement(CompatibilityLayerSection, {
        isWindowsHost: false,
        preview: basePreview,
        activeDisplayMethod: 'compatibility_layer',
        detectedLayers: [],
        runnerUpdates: {},
        compatibilityLayer: 'crossover_preview',
        onSelectCompatibilityLayer: vi.fn(),
        availableBottles: [],
        wineBottleName: '',
        onChangeWineBottleName: vi.fn(),
        selectedRunnerDescriptor: nonAutoDescriptor,
        activeLayer: undefined,
        activeInstalledVer: undefined,
        activeSecondaryBuildText: '',
        isCheckingUpdates: false,
        isUpdatingRunner: false,
        onUpdateRunner: vi.fn(),
        onCheckRunnerUpdates: vi.fn(),
        onSwitchToStableCrossOver: switchSpy,
        onInstallRunnerFromArchive: archiveSpy,
        onOpenBottleFolder: vi.fn(),
        isRescanningRunners: false,
        onRescanLayers: vi.fn(),
        isInstallingRunner: false,
        onInstallRunnerViaBrew: vi.fn(),
        onDownloadRunner: vi.fn(),
        runnerUpdateFeedback: 'Up to date.',
        runnerActionFeedback: { tone: 'emerald', text: 'Ready.' },
        winePrefixPath: '',
        onChangeWinePrefixPath: vi.fn(),
        onBrowseWinePrefix: vi.fn(),
        crossoverGraphicsBackend: 'auto',
        onChangeCrossoverGraphicsBackend: vi.fn(),
        crossoverD3DMetalVersion: 'auto',
        onChangeCrossoverD3DMetalVersion: vi.fn(),
        showD3DMetalVersionSelector: false,
        primaryD3DVer: '4.0b3',
        fallbackD3DVer: '3.0',
        onChangeCrossoverHighResolutionMode: vi.fn(),
        isDlssSupportedBackend: false,
        isDxvkHudSupported: false,
        crossoverDlss: false,
        onToggleCrossoverDlss: vi.fn(),
        wineMsync: true,
        onToggleWineMsync: vi.fn(),
        wineEsync: false,
        onToggleWineEsync: vi.fn(),
        metalHud: false,
        onToggleMetalHud: vi.fn(),
        dxvkHud: false,
        onToggleDxvkHud: vi.fn(),
      });
      const archiveRenderer = createDomain12DeepRenderer(() => archiveSection, {});
      const archiveTree = archiveRenderer.render();
      const archiveBtn = findByTestId(archiveTree, 'install-runner-archive-btn');
      expect(archiveBtn).toBeDefined();
      archiveBtn!.props.onClick();
      expect(archiveSpy).toHaveBeenCalledTimes(1);

      const statusFeedback = findByTestId(archiveTree, 'runner-action-feedback');
      expect(statusFeedback?.props.role).toBe('status');
      expect(statusFeedback?.props['aria-live']).toBe('polite');
      archiveRenderer.unmount();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('C2-T10: TopNavBar avoids hardcoded 0.2.6 version flash and handles keyboard Escape + focus restoration cleanly', async () => {
    const winObj = globalThis as unknown as {
      window?: { electronAPI?: Record<string, unknown> };
      localStorage?: Storage;
    };
    const hadWindow = Boolean(winObj.window);
    const prevStorage = winObj.localStorage;
    if (!winObj.window) {
      winObj.window = {};
    }
    if (!winObj.localStorage) {
      winObj.localStorage = createMemoryStorage();
    }
    winObj.window.electronAPI = {
      isElectron: true,
      platform: 'win32',
      arch: 'x64',
      getAppVersion: vi.fn().mockResolvedValue('0.9.1'),
      checkForAppUpdates: vi.fn().mockResolvedValue({
        currentVersion: '0.9.1',
        latestVersion: '0.9.1',
        hasUpdate: false,
      }),
    };

    try {
      const navRenderer = createDomain12DeepRenderer(TopNavBar, {
        selectedPlatform: 'all',
        onSelectPlatform: vi.fn(),
        installedOnly: false,
        onToggleInstalledOnly: vi.fn(),
        totalGamesCount: 1,
        filteredCount: 1,
        isSyncing: false,
        onTriggerSync: vi.fn(),
        onHomeClick: vi.fn(),
        onOpenIntegrations: vi.fn(),
        defaultMenuOpen: true,
      });

      const initialTree = navRenderer.render();
      expect(getTextContent(initialTree)).not.toContain('0.2.6');
      expect(findByTestId(initialTree, 'menu-app-version')).toBeUndefined();

      await Promise.resolve();
      await Promise.resolve();
      let resolvedTree = navRenderer.render();
      expect(getTextContent(findByTestId(resolvedTree, 'menu-app-version'))).toBe('v0.9.1');

      // Keyboard Escape on Edit top menu trigger closes dropdown cleanly
      const editTrigger = findVNodes(
        resolvedTree,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Edit'
      )[0];
      expect(editTrigger).toBeDefined();
      editTrigger.props.onKeyDown({
        key: 'ArrowDown',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
      resolvedTree = navRenderer.render();
      const editMenu = findByTestId(resolvedTree, 'win-menu-dropdown-edit');
      expect(editMenu).toBeDefined();

      editMenu!.props.onKeyDown({
        key: 'Escape',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
      resolvedTree = navRenderer.render();
      const editMenuAfterEsc = findByTestId(resolvedTree, 'win-menu-dropdown-edit');
      expect(editMenuAfterEsc).toBeUndefined();
      navRenderer.unmount();
    } finally {
      if (!hadWindow) {
        delete winObj.window;
      }
      if (prevStorage === undefined) {
        delete winObj.localStorage;
      } else {
        winObj.localStorage = prevStorage;
      }
    }
  });

  // =========================================================================
  // Part C — Round 3 Challenger Remediations (R3-C1-2..3 & R3-C2-1..3 + Bonus)
  // =========================================================================

  it('R3-C1-2: ensure_bottle, sync_first_party_manifests, and installRunnerDirect preserve sibling-branch cached preview URLs', async () => {
    const sandbox = makeTempSandbox('ol-t5-r3-c1-2-');
    try {
      const appsDir = path.join(sandbox, 'Applications');
      seedCrossOverApp(appsDir, { arm64: true, version: '20261111' });
      const bottleDir = path.join(
        sandbox,
        'Library/Application Support/CrossOver/Bottles/OneLauncher-arm64'
      );
      fs.mkdirSync(path.join(bottleDir, 'drive_c/windows/system32'), { recursive: true });
      fs.writeFileSync(path.join(bottleDir, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
      fs.writeFileSync(
        path.join(bottleDir, 'cxbottle.conf'),
        '[Bottle]\n"WineArch" = "arm64"\n"Preview" = "1"\n',
        'utf8'
      );

      const armUrl =
        'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip';
      const stdUrl =
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip';
      macNativeInstaller.setCachedAuthenticatedPreviewUrl(armUrl, { previewBranch: 'arm64' });
      macNativeInstaller.setCachedAuthenticatedPreviewUrl(stdUrl, { previewBranch: 'standard' });

      await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [
            {
              action: 'ensure_bottle',
              componentId: 'bottle_default',
              runnerType: 'crossover_preview_arm64',
              bottleName: 'OneLauncher-arm64',
            },
            {
              action: 'sync_first_party_manifests',
              componentId: 'bottle_steam',
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sandbox,
          userDataDir: path.join(sandbox, 'userData'),
          customApplicationsDir: appsDir,
          execFileFn: (
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: Error | null, stdout: string, stderr: string) => void
          ) => cb(null, '', ''),
        }
      );

      expect(
        macNativeInstaller.getCachedAuthenticatedPreviewUrl({
          previewBranch: 'arm64',
          allowCachedPreviewUrlInTest: true,
        })
      ).toBe(armUrl);
      expect(
        macNativeInstaller.getCachedAuthenticatedPreviewUrl({
          previewBranch: 'standard',
          allowCachedPreviewUrlInTest: true,
        })
      ).toBe(stdUrl);

      // Single-runner archive install of standard preview must also preserve arm64 URL cache
      const stagedZip = path.join(sandbox, 'crossover-preview-20261111.zip');
      fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');
      const installRes = await environmentProvisioner.installRunnerDirect('crossover_preview', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox,
        customApplicationsDir: appsDir,
        archivePath: stagedZip,
        skipProcessCheck: true,
        skipStagingCodesignVerify: true,
        verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
        onExtractArchive: async (_zip: string, extractDir: string) => {
          seedCrossOverApp(extractDir, { arm64: false, bundleName: 'CrossOver Preview.app' });
        },
      });
      expect(installRes.success).toBe(true);
      expect(
        macNativeInstaller.getCachedAuthenticatedPreviewUrl({
          previewBranch: 'arm64',
          allowCachedPreviewUrlInTest: true,
        })
      ).toBe(armUrl);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('R3-C1-3: verifyAndPrepareCodeWeaversStagedApp rejects Intel-only bundle for crossover_preview_arm64 and arm64 bundle for crossover_preview', async () => {
    const sandbox = makeTempSandbox('ol-t5-r3-c1-3-');
    try {
      const appsDir = path.join(sandbox, 'Applications');
      fs.mkdirSync(appsDir, { recursive: true });
      const stagedZip = path.join(sandbox, 'mismatched-preview.zip');
      fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');

      // 1. Intel-only bundle staged for crossover_preview_arm64 must fail before swap
      await expect(
        environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sandbox,
          customApplicationsDir: appsDir,
          archivePath: stagedZip,
          skipProcessCheck: true,
          skipStagingCodesignVerify: true,
          verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
          onExtractArchive: async (_zip: string, extractDir: string) => {
            seedCrossOverApp(extractDir, { arm64: false, bundleName: 'CrossOver Preview.app' });
          },
        })
      ).rejects.toThrow(/Intel\/standard CrossOver bundle without arm64 FEX runtime markers/i);
      expect(fs.existsSync(path.join(appsDir, 'CrossOver Preview arm64.app'))).toBe(false);

      // 2. Arm64 bundle staged for standard crossover_preview must fail before swap
      await expect(
        environmentProvisioner.installRunnerDirect('crossover_preview', {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sandbox,
          customApplicationsDir: appsDir,
          archivePath: stagedZip,
          skipProcessCheck: true,
          skipStagingCodesignVerify: true,
          verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
          onExtractArchive: async (_zip: string, extractDir: string) => {
            seedCrossOverApp(extractDir, { arm64: true, bundleName: 'CrossOver Preview.app' });
          },
        })
      ).rejects.toThrow(/arm64 CrossOver Preview bundle, which cannot be installed as CrossOver Preview/i);
      expect(fs.existsSync(path.join(appsDir, 'CrossOver Preview.app'))).toBe(false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('R3-C2-1: dual-OS GameInstallModal allows native macOS install even with mismatched saved bottle and emits no dangling aria-describedby', async () => {
    const sandbox = makeTempSandbox('ol-t5-r3-c2-1-');
    try {
      const armLayer = makeLayer('crossover_preview_arm64', sandbox, {
        availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64', previewEnabled: true },
          'OneLauncher-arm64': { wineArch: 'arm64', previewEnabled: true },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 't5-r3-c2-1-game',
        title: 'Dual OS GOG Game',
        platforms: [{ platformId: 'gog', platformGameId: '996001', installed: false }],
      });

      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([armLayer]);
      vi.spyOn(launcherService, 'setSelectedStorefrontForGame').mockImplementation(() => {});
      const startInstallSpy = vi
        .spyOn(launcherService, 'startInstall')
        .mockResolvedValue({
          success: true,
          task: {
            taskId: 'dl-1',
            gameId: game.id,
            title: game.title,
            platformId: 'gog',
            platformGameId: '996001',
            status: 'downloading',
            progressPercent: 0,
            bytesDownloaded: 0,
            totalBytes: 1024,
            speedBytesPerSec: 0,
            installDir: path.join(sandbox, 'Games/DualOS'),
            startedAt: '2026-11-18T00:00:00.000Z',
          },
        });
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'gog',
        platformGameId: '996001',
        defaultInstallDir: path.join(sandbox, 'Games/DualOS'),
        availableInstallDirs: [path.join(sandbox, 'Games/DualOS')],
        canDirectDownload: true,
        estimatedSizeBytes: 1024,
        availableInstallers: [
          { id: 'gog_mac', name: 'macOS Installer', os: 'mac', totalSizeBytes: 1024 },
          { id: 'gog_win', name: 'Windows Installer', os: 'windows', totalSizeBytes: 1024 },
        ],
        diskSpace: {
          targetPath: path.join(sandbox, 'Games/DualOS'),
          freeBytes: 100_000_000_000,
          usedBytes: 100_000_000_000,
          totalBytes: 200_000_000_000,
        },
      });

      // Scenario A: saved launchMethod === 'auto' defaults to selectedOs === 'mac'
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        launchMethod: 'auto',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher',
      });

      const rendererA = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'gog',
        onClose: vi.fn(),
      });
      rendererA.render();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const treeA = rendererA.render();

      expect(findByTestId(treeA, 'preinstall-compat-config')).toBeUndefined();
      expect(findByTestId(treeA, 'preinstall-bottle-arch-warning')).toBeUndefined();
      const startBtnA = findVNodes(
        treeA,
        (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
      )[0];
      expect(startBtnA.props.disabled).toBe(false);
      expect(startBtnA.props['aria-describedby']).toBeUndefined();
      await startBtnA.props.onClick();
      expect(startInstallSpy).toHaveBeenCalledTimes(1);
      rendererA.unmount();

      // Scenario B: saved launchMethod === 'compatibility_layer' starts on Windows (blocked), then switch to macOS (unblocked)
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher',
      });

      const rendererB = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'gog',
        onClose: vi.fn(),
      });
      rendererB.render();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      let treeB = rendererB.render();

      expect(findByTestId(treeB, 'preinstall-bottle-arch-warning')).toBeDefined();
      let startBtnB = findVNodes(
        treeB,
        (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
      )[0];
      expect(startBtnB.props.disabled).toBe(true);

      const macOptionBtn = findByTestId(treeB, 'install-option-mac-native');
      expect(macOptionBtn).toBeDefined();
      macOptionBtn!.props.onClick();
      treeB = rendererB.render();

      expect(findByTestId(treeB, 'preinstall-bottle-arch-warning')).toBeUndefined();
      startBtnB = findVNodes(
        treeB,
        (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
      )[0];
      expect(startBtnB.props.disabled).toBe(false);
      expect(startBtnB.props['aria-describedby']).toBeUndefined();
      rendererB.unmount();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('R3-C2-2: isValidBottleNameInput matches IPC slug rules and Setup Wizard blocks Next on incompatible existing bottle', async () => {
    expect(isValidBottleNameInput('-evil')).toBe(false);
    expect(isValidBottleNameInput('--flag')).toBe(false);
    expect(isValidBottleNameInput('-')).toBe(false);
    expect(isValidBottleNameInput('.')).toBe(false);
    expect(isValidBottleNameInput('..')).toBe(false);
    expect(isValidBottleNameInput('OneLauncher-arm64')).toBe(true);

    const sandbox = makeTempSandbox('ol-t5-r3-c2-2-');
    try {
      const snapshot = makeWizardSnapshot(sandbox);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(snapshot);
      vi.spyOn(environmentSetupService, 'probeHealth').mockResolvedValue(snapshot);
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue({
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        preferredRunnerType: 'crossover_preview_arm64',
        preferredBottleName: 'OneLauncher-arm64',
        configuredComponents: [],
      });
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');

      const renderer = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'first_launch',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      renderer.render();
      await Promise.resolve();
      await Promise.resolve();
      let tree = renderer.render();

      // Valid compatible bottle -> Next enabled
      let nextBtn = findByTestId(tree, 'setup-next-step-btn');
      expect(nextBtn?.props.disabled).toBe(false);

      // Type incompatible existing win64 bottle 'OneLauncher' for crossover_preview_arm64 -> Next disabled
      const bottleInput = findByTestId(tree, 'setup-bottle-name-input');
      expect(bottleInput).toBeDefined();
      bottleInput!.props.onChange({ target: { value: 'OneLauncher' } });
      tree = renderer.render();

      expect(findByTestId(tree, 'setup-bottle-arch-warning')).toBeDefined();
      nextBtn = findByTestId(tree, 'setup-next-step-btn');
      expect(nextBtn?.props.disabled).toBe(true);

      // Type invalid leading-hyphen bottle '-evil' -> alert shown and Next disabled
      findByTestId(tree, 'setup-bottle-name-input')!.props.onChange({
        target: { value: '-evil' },
      });
      tree = renderer.render();
      expect(findByTestId(tree, 'setup-bottle-name-input')?.props['aria-invalid']).toBe(true);
      expect(findByTestId(tree, 'setup-next-step-btn')?.props.disabled).toBe(true);

      // Restore valid compatible bottle 'OneLauncher-arm64' -> Next re-enabled
      findByTestId(tree, 'setup-bottle-name-input')!.props.onChange({
        target: { value: 'OneLauncher-arm64' },
      });
      tree = renderer.render();
      expect(findByTestId(tree, 'setup-next-step-btn')?.props.disabled).toBe(false);
      renderer.unmount();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('R3-C2-3: GameInstallModal prefers OneLauncher-arm64 over earlier custom bottle names', async () => {
    const sandbox = makeTempSandbox('ol-t5-r3-c2-3-');
    try {
      const armLayer = makeLayer('crossover_preview_arm64', sandbox, {
        availableBottles: ['CustomArm', 'OneLauncher-arm64'],
        bottleDetails: {
          CustomArm: { wineArch: 'arm64', previewEnabled: true },
          'OneLauncher-arm64': { wineArch: 'arm64', previewEnabled: true },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 't5-r3-c2-3-game',
        title: 'Custom Bottle Order Game',
        platforms: [{ platformId: 'steam', platformGameId: '997001', installed: false }],
      });

      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([armLayer]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
      });
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '997001',
        defaultInstallDir: '~/Library/Application Support/CrossOver/Bottles/OneLauncher-arm64',
        availableInstallDirs: [],
        canDirectDownload: true,
        estimatedSizeBytes: 1024,
        availableInstallers: [
          { id: 'steam_win', name: 'Windows Build', os: 'windows', totalSizeBytes: 1024 },
        ],
        diskSpace: {
          targetPath: path.join(sandbox, 'Games/CustomOrder'),
          freeBytes: 100_000_000_000,
          usedBytes: 100_000_000_000,
          totalBytes: 200_000_000_000,
        },
      });

      const renderer = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      renderer.render();
      await Promise.resolve();
      await Promise.resolve();
      const tree = renderer.render();

      const bottleSel = findByTestId(tree, 'preinstall-compat-bottle');
      expect(bottleSel).toBeDefined();
      const defaultOpt = findVNodes(
        bottleSel,
        (el) => el.type === 'option' && el.props?.value === ''
      )[0];
      expect(getTextContent(defaultOpt)).toContain('Default Bottle (OneLauncher-arm64)');

      const steamDisplay = findByTestId(tree, 'steam-library-location-display');
      expect(getTextContent(steamDisplay)).toContain(
        '/Bottles/OneLauncher-arm64/drive_c/'
      );
      expect(getTextContent(steamDisplay)).toContain(
        'CrossOver / Wine Bottle Steam Library (OneLauncher-arm64)'
      );
      renderer.unmount();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('R3-C2-Bonus: switching runner dropdown mid-flight hides runner-live-progress-panel on unrelated runner while keeping action buttons disabled', async () => {
    const sandbox = makeTempSandbox('ol-t5-r3-c2-bonus-');
    try {
      const armLayer = makeLayer('crossover_preview_arm64', sandbox);
      const cxLayer = makeLayer('crossover', sandbox);
      const game = makeCanonicalGameFixture({
        id: 't5-r3-c2-bonus-game',
        title: 'Dropdown Progress Gate Game',
        platforms: [{ platformId: 'steam', platformGameId: '998001', installed: true }],
      });

      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([armLayer, cxLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([armLayer, cxLayer]);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({
        crossover_preview_arm64: {
          runnerType: 'crossover_preview_arm64',
          installed: true,
          installedVersion: '20261015',
          latestVersion: '20261111',
          updateAvailable: true,
          canAutoUpdate: true,
          checkedAt: '2026-11-18T00:00:00.000Z',
        },
        crossover: {
          runnerType: 'crossover',
          installed: true,
          installedVersion: '26.2.0',
          latestVersion: '26.4.0',
          updateAvailable: true,
          canAutoUpdate: true,
          checkedAt: '2026-11-18T00:00:00.000Z',
        },
      });
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
        crossover_preview_arm64: {
          runnerType: 'crossover_preview_arm64',
          installed: true,
          installedVersion: '20261015',
          latestVersion: '20261111',
          updateAvailable: true,
          canAutoUpdate: true,
          checkedAt: '2026-11-18T00:00:00.000Z',
        },
        crossover: {
          runnerType: 'crossover',
          installed: true,
          installedVersion: '26.2.0',
          latestVersion: '26.4.0',
          updateAvailable: true,
          canAutoUpdate: true,
          checkedAt: '2026-11-18T00:00:00.000Z',
        },
      });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
      });

      const resolveHolder: { fn: ((v: UpdateCompatibilityLayerResult) => void) | null } = {
        fn: null,
      };
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(
        () =>
          new Promise<UpdateCompatibilityLayerResult>((resolve) => {
            resolveHolder.fn = resolve;
          })
      );

      let latestForm: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const Harness: React.FC = () => {
        const form = useGameLaunchConfigForm({
          isOpen: true,
          game,
          initialPlatformId: 'steam',
          onClose: vi.fn(),
        });
        latestForm = form;
        return React.createElement(CompatibilityLayerSection, {
          isWindowsHost: form.isWindowsHost,
          preview: form.preview,
          activeDisplayMethod: form.activeDisplayMethod,
          detectedLayers: form.detectedLayers,
          runnerUpdates: form.runnerUpdates,
          compatibilityLayer: form.compatibilityLayer,
          onSelectCompatibilityLayer: form.handleSelectCompatibilityLayer,
          availableBottles: form.availableBottles,
          wineBottleName: form.wineBottleName,
          onChangeWineBottleName: form.setWineBottleName,
          selectedRunnerDescriptor: form.selectedRunnerDescriptor,
          activeLayer: form.activeLayer,
          activeUpdateInfo: form.activeUpdateInfo,
          activeInstalledVer: form.activeInstalledVer,
          activeSecondaryBuildText: form.activeSecondaryBuildText,
          activeRunnerProgress: form.activeRunnerProgress,
          isCheckingUpdates: form.isCheckingUpdates,
          isUpdatingRunner: form.isUpdatingRunner,
          onUpdateRunner: form.handleUpdateRunner,
          onCheckRunnerUpdates: form.handleCheckRunnerUpdates,
          onCancelRunnerOperation: form.handleCancelRunnerOperation,
          resolvedBottleFolderPath: form.resolvedBottleFolderPath,
          onOpenBottleFolder: form.handleOpenBottleFolder,
          isRescanningRunners: form.isRescanningRunners,
          onRescanLayers: form.handleRescanLayers,
          isInstallingRunner: form.isInstallingRunner,
          isAnotherRunnerOperationActive: form.isAnotherRunnerOperationActive,
          onInstallRunnerViaBrew: form.handleInstallRunnerViaBrew,
          onDownloadRunner: form.handleDownloadRunner,
          runnerUpdateFeedback: form.runnerUpdateFeedback,
          runnerActionFeedback: form.runnerActionFeedback,
          winePrefixPath: form.winePrefixPath,
          onChangeWinePrefixPath: form.setWinePrefixPath,
          onBrowseWinePrefix: form.handleBrowseWinePrefix,
          crossoverGraphicsBackend: form.crossoverGraphicsBackend,
          onChangeCrossoverGraphicsBackend: form.setCrossoverGraphicsBackend,
          crossoverD3DMetalVersion: form.crossoverD3DMetalVersion,
          onChangeCrossoverD3DMetalVersion: form.setCrossoverD3DMetalVersion,
          showD3DMetalVersionSelector: form.showD3DMetalVersionSelector,
          primaryD3DVer: form.primaryD3DVer,
          fallbackD3DVer: form.fallbackD3DVer,
          onChangeCrossoverHighResolutionMode: form.setCrossoverHighResolutionMode,
          isDlssSupportedBackend: form.isDlssSupportedBackend,
          isDxvkHudSupported: form.isDxvkHudSupported,
          crossoverDlss: form.crossoverDlss,
          onToggleCrossoverDlss: form.handleToggleCrossoverDlss,
          wineMsync: form.wineMsync,
          onToggleWineMsync: form.handleToggleWineMsync,
          wineEsync: form.wineEsync,
          onToggleWineEsync: form.handleToggleWineEsync,
          metalHud: form.metalHud,
          onToggleMetalHud: form.handleToggleMetalHud,
          dxvkHud: form.dxvkHud,
          onToggleDxvkHud: form.handleToggleDxvkHud,
        });
      };

      const renderer = createDomain12DeepRenderer(Harness, {});
      renderer.render();
      await Promise.resolve();
      let tree = renderer.render();

      const updatePromise = latestForm!.handleUpdateRunner();
      tree = renderer.render();
      expect(findByTestId(tree, 'runner-live-progress-panel')).toBeDefined();

      // Switch dropdown to unrelated 'crossover'
      latestForm!.handleSelectCompatibilityLayer('crossover');
      tree = renderer.render();
      expect(findByTestId(tree, 'runner-live-progress-panel')).toBeUndefined();
      const crossoverUpdateBtn = findByTestId(tree, 'update-runner-btn');
      expect(crossoverUpdateBtn?.props.disabled).toBe(true);

      // Switch back to 'crossover_preview_arm64' -> progress panel visible again
      latestForm!.handleSelectCompatibilityLayer('crossover_preview_arm64');
      tree = renderer.render();
      expect(findByTestId(tree, 'runner-live-progress-panel')).toBeDefined();

      resolveHolder.fn?.({
        success: true,
        runnerType: 'crossover_preview_arm64',
        updated: true,
        message: 'Updated',
      });
      await updatePromise;
      renderer.unmount();
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
