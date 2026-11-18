import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';

import type { CanonicalGame } from '../src/contracts/game';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  type CompatibilityLayerInfo,
  type CompatibilityLayerUpdateInfo,
  type CompatibilityRunnerProgressEvent,
  type InstalledGameRecord,
} from '../src/contracts/launcher';
import type {
  EnvironmentComponentId,
  EnvironmentHealthSnapshot,
} from '../src/contracts/environmentSetup';
import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  buildEffectiveLaunchModePreview,
} from '../src/services/launcher/launchPolicyPreview';
import {
  LauncherService,
  launcherService,
} from '../src/services/launcher/launcherService';
import {
  EnvironmentSetupService,
  buildFallbackEnvironmentSnapshot,
  buildProvisioningTasksFromSelection,
  environmentSetupService,
} from '../src/services/launcher/environmentSetupService';
import { CompatibilityAndBottleStep } from '../src/components/Launcher/SystemSetupWizard/steps/CompatibilityAndBottleStep';
import { GuidedClientSignInStep } from '../src/components/Launcher/SystemSetupWizard/steps/GuidedClientSignInStep';
import { SystemSetupWizardModal } from '../src/components/Launcher/SystemSetupWizard/SystemSetupWizardModal';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import { CompatibilityLayerSection } from '../src/components/Launcher/LaunchConfig/CompatibilityLayerSection';
import { useGameLaunchConfigForm } from '../src/components/Launcher/LaunchConfig/useGameLaunchConfigForm';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';
import { formatUserFacingPath } from '../src/components/Launcher/LaunchConfig/launchConfigHelpers';
import {
  createDomain12DeepRenderer,
  findElements,
  getTextContent,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';

const nodeRequire = createRequire(import.meta.url);
const launcherIpcHandlers = nodeRequire('../electron/ipc/launcherIpcHandlers.cjs');
const macNativeInstaller = nodeRequire('../electron/launcher/macNativeInstallerAndCodesign.cjs');

function findVNodes(node: unknown, predicate: (el: React.ReactElement<any>) => boolean): React.ReactElement<any>[] {
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

function findByTestId(node: unknown, testId: string): React.ReactElement<any> | undefined {
  return findVNodes(node, (el) => el.props?.['data-testid'] === testId)[0];
}

function makeLayer(
  type: CompatibilityLayerInfo['type'],
  appsRoot: string,
  overrides: Partial<CompatibilityLayerInfo> = {}
): CompatibilityLayerInfo {
  const isArm64 = type === 'crossover_preview_arm64';
  const isPreview = type === 'crossover_preview' || isArm64;
  const appName = isPreview ? 'CrossOver Preview.app' : 'CrossOver.app';
  const bottlesDir = path.join(
    appsRoot,
    'Library',
    'Application Support',
    isPreview ? 'CrossOver' : 'CrossOver',
    isArm64 ? 'BottlesArm64' : 'Bottles'
  );
  return {
    id: type,
    type,
    name: isArm64
      ? 'CrossOver Preview (arm64 / FEX)'
      : isPreview
        ? 'CrossOver Preview'
        : 'CrossOver',
    appPath: path.join(appsRoot, 'Applications', appName),
    binaryPath: path.join(appsRoot, 'Applications', appName, 'Contents/SharedSupport/CrossOver/bin/wine'),
    bottlesDir,
    availableBottles: [isArm64 ? 'OneLauncher-arm64' : 'OneLauncher'],
    version: isPreview ? '27.0.0' : '26.2.0',
    buildVersion: isPreview ? '20261111' : '26.2.0',
    displayVersion: isPreview ? '27.0.0 (Preview 20261111)' : '26.2.0',
    previewBranch: isArm64 ? 'arm64' : isPreview ? 'standard' : undefined,
    previewDate: isPreview ? '20261111' : undefined,
    supportedBottleArches: isArm64 ? ['arm64'] : ['win64'],
    supportsMetalFxDlssD3dMetal: true,
    ...overrides,
  };
}

function makeSnapshot(
  opts: {
    hostArch?: 'arm64' | 'x64';
    hostPlatform?: 'darwin' | 'win32' | 'linux';
    installedRunners?: Array<'crossover' | 'crossover_preview' | 'crossover_preview_arm64' | 'wine' | 'gptk'>;
    previewArm64AuthRequired?: boolean;
    previewArm64UpdateVersion?: string;
    availableBottles?: EnvironmentHealthSnapshot['bottleSummary']['availableBottles'];
    pendingSteamLogin?: boolean;
  } = {}
): EnvironmentHealthSnapshot {
  const hostPlatform = opts.hostPlatform || 'darwin';
  const hostArch = opts.hostArch || 'arm64';
  const isAppleSiliconMac = hostPlatform === 'darwin' && hostArch === 'arm64';
  const installedSet = new Set(opts.installedRunners || ['crossover', 'crossover_preview']);
  const base = buildFallbackEnvironmentSnapshot(['steam']);

  const availableBottles = opts.availableBottles || [
    {
      name: 'OneLauncher',
      path: '/Applications/CrossOver/Bottles/OneLauncher',
      runnerType: 'crossover_preview',
      wineArch: 'win64',
      bottleArch: 'win64',
      isValid: true,
      hasSteam: true,
      hasGogGalaxy: false,
      hasEpicLauncher: false,
      isSandboxed: false,
    },
    {
      name: 'OneLauncher-arm64',
      path: '/Applications/CrossOver/BottlesArm64/OneLauncher-arm64',
      runnerType: 'crossover_preview_arm64',
      wineArch: 'arm64',
      bottleArch: 'arm64',
      isValid: true,
      hasSteam: false,
      hasGogGalaxy: false,
      hasEpicLauncher: false,
      isSandboxed: false,
    },
  ];

  return {
    ...base,
    probedAt: '2026-11-18T00:00:00.000Z',
    hostPlatform,
    hostArch,
    isAppleSiliconMac,
    detectedRunners: [],
    bottleSummary: {
      runnerType: installedSet.has('crossover')
        ? 'crossover'
        : installedSet.has('crossover_preview_arm64')
          ? 'crossover_preview_arm64'
          : 'crossover_preview',
      runnerInstalled: installedSet.size > 0,
      availableBottles,
      recommendedBottleMode: availableBottles.length > 0 ? 'reuse_existing' : 'create_dedicated',
      recommendedBottleName: 'OneLauncher',
    },
    components: {
      ...base.components,
      rosetta2: {
        ...base.components.rosetta2,
        status: 'ready',
        statusDetail: 'Installed',
      },
      runner_crossover: {
        ...base.components.runner_crossover,
        status: installedSet.has('crossover') ? 'ready' : 'missing',
        statusDetail: installedSet.has('crossover') ? 'Installed' : 'Not installed',
      },
      runner_crossover_preview: {
        ...base.components.runner_crossover_preview,
        status: installedSet.has('crossover_preview') ? 'ready' : 'missing',
        statusDetail: installedSet.has('crossover_preview') ? 'Installed' : 'Not installed',
      },
      runner_crossover_preview_arm64: {
        ...base.components.runner_crossover_preview_arm64,
        status: opts.previewArm64UpdateVersion
          ? 'update_available'
          : installedSet.has('crossover_preview_arm64')
            ? 'ready'
            : 'missing',
        statusDetail: opts.previewArm64UpdateVersion
          ? `Update available: ${opts.previewArm64UpdateVersion}`
          : installedSet.has('crossover_preview_arm64')
            ? 'Installed'
            : 'Not installed',
        latestVersion: opts.previewArm64UpdateVersion,
        latestDisplayVersion: opts.previewArm64UpdateVersion
          ? `Preview ${opts.previewArm64UpdateVersion}`
          : undefined,
        authRequired: opts.previewArm64AuthRequired,
        canAutoInstall: isAppleSiliconMac,
      },
      runner_wine: {
        ...base.components.runner_wine,
        status: installedSet.has('wine') ? 'ready' : 'missing',
      },
      runner_gptk: {
        ...base.components.runner_gptk,
        status: installedSet.has('gptk') ? 'ready' : 'missing',
        canAutoInstall: isAppleSiliconMac,
      },
      bottle_default: {
        ...base.components.bottle_default,
        status: 'ready',
        statusDetail: 'Ready',
      },
      host_steam: {
        ...base.components.host_steam,
        status: 'ready',
        statusDetail: 'Ready',
      },
    },
    clientLogins: {
      ...base.clientLogins,
      host_steam: {
        ...base.clientLogins.host_steam,
        installed: true,
        authenticated: !opts.pendingSteamLogin,
        accountMatchesOneLauncher: opts.pendingSteamLogin ? false : true,
        statusSummary: opts.pendingSteamLogin ? 'Sign in required' : 'Signed in',
      },
    },
  };
}

describe('M3 Dual-Branch arm64 UI, IPC, Services & Accessibility Integration', () => {
  let tmpRoot: string;
  const origPlatform = process.platform;
  const origArch = process.arch;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-m3-unit-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('F9 — IPC Sanitization, Contracts & Preload Forwarding', () => {
    it('normalizes runner aliases and preserves authenticateOnly while stripping untrusted fields', () => {
      const aliasCheck = launcherIpcHandlers.sanitizeCompatLayerPayload(
        { runnerType: '  RUNNER_CROSSOVER_PREVIEW_ARM64 ', mode: 'auto' },
        'install'
      );
      expect(aliasCheck.ok).toBe(true);
      expect(aliasCheck.payload?.runnerType).toBe('crossover_preview_arm64');

      const whiskyRejected = launcherIpcHandlers.sanitizeCompatLayerPayload(
        { runnerType: 'whisky' },
        'install'
      );
      expect(whiskyRejected.ok).toBe(false);

      const installCheck = launcherIpcHandlers.sanitizeCompatLayerPayload(
        {
          runnerType: 'runner_crossover_preview_arm64',
          mode: 'auto',
          authenticateOnly: true,
          downloadUrl: 'https://evil.example/payload.zip',
          previewBranch: 'x64',
          homedir: tmpRoot,
          execFileFn: 'injected',
        },
        'install'
      );
      expect(installCheck.ok).toBe(true);
      expect(installCheck.payload).toEqual({
        runnerType: 'crossover_preview_arm64',
        mode: 'auto',
        authenticateOnly: true,
      });

      const updateCheck = launcherIpcHandlers.sanitizeCompatLayerPayload(
        {
          runnerType: 'crossover_preview_arm64',
          authenticateOnly: true,
          downloadUrl: 'javascript:alert(1)',
        },
        'update'
      );
      expect(updateCheck.ok).toBe(true);
      expect(updateCheck.payload).toEqual({
        runnerType: 'crossover_preview_arm64',
        authenticateOnly: true,
      });

      const rejected = launcherIpcHandlers.sanitizeCompatLayerPayload(
        { runnerType: '../crossover_preview_arm64' },
        'update'
      );
      expect(rejected.ok).toBe(false);
    });

    it('sanitizes setup tasks, guided login, setup wizard state, and cancel op for crossover_preview_arm64', () => {
      const taskCheck = launcherIpcHandlers.sanitizeEnvironmentSetupTasksPayload({
        runId: 'm3-run',
        tasks: [
          {
            action: 'install_runner',
            componentId: 'runner_crossover_preview_arm64',
            runnerType: 'runner_crossover_preview_arm64',
            bottleName: 'OneLauncher-arm64',
            downloadUrl: 'https://untrusted.example/arm64.zip',
          },
        ],
      });
      expect(taskCheck.ok).toBe(true);
      expect(taskCheck.payload?.tasks[0]).toEqual({
        action: 'install_runner',
        componentId: 'runner_crossover_preview_arm64',
        runnerType: 'crossover_preview_arm64',
        bottleName: 'OneLauncher-arm64',
      });

      const loginCheck = launcherIpcHandlers.sanitizeGuidedClientLoginPayload({
        targetId: 'host_steam',
        runnerType: 'runner_crossover_preview_arm64',
        bottleName: 'OneLauncher-arm64',
      });
      expect(loginCheck.ok).toBe(true);
      expect(loginCheck.payload?.runnerType).toBe('crossover_preview_arm64');

      const wizardPatch = launcherIpcHandlers.sanitizeSetupWizardStatePatch({
        preferredRunnerType: 'runner_crossover_preview_arm64',
        preferredBottleName: 'OneLauncher-arm64',
        addConfiguredComponents: ['runner_crossover_preview_arm64'],
      });
      expect(wizardPatch.preferredRunnerType).toBe('crossover_preview_arm64');
      expect(wizardPatch.preferredBottleName).toBe('OneLauncher-arm64');
      expect(wizardPatch.addConfiguredComponents).toEqual(['runner_crossover_preview_arm64']);
    });

    it('forwards forceFresh & forceRefreshRunnerUpdates on probe IPC and builds arm64 fallback snapshot', async () => {
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const mockIpcMain = {
        handle: vi.fn((ch: string, fn: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(ch, fn);
        }),
        removeHandler: vi.fn(),
      };
      const probeMock = vi.fn().mockResolvedValue(null);
      const mockEngine = {
        probeEnvironmentHealth: probeMock,
        installCompatibilityLayer: vi.fn().mockResolvedValue({ success: true, runnerType: 'crossover_preview_arm64' }),
        updateCompatibilityLayer: vi.fn().mockResolvedValue({ success: true, runnerType: 'crossover_preview_arm64' }),
        cancelCompatibilityLayerOperation: vi.fn().mockResolvedValue({ success: true }),
      };

      launcherIpcHandlers.registerLauncherIpcHandlers({
        ipcMain: mockIpcMain,
        launcherEngine: mockEngine,
        electronApp: { getPath: () => tmpRoot },
        browserWindowClass: { getAllWindows: () => [] },
        shellApi: { openExternal: vi.fn() },
        dialogApi: { showOpenDialog: vi.fn() },
        getMainWindow: () => null,
      });

      const probeHandler = handlers.get('launcher:probe-environment-health');
      expect(probeHandler).toBeDefined();
      const fallbackSnap = (await probeHandler!(null, {
        connectedStorefronts: ['steam'],
        forceFresh: true,
        forceRefreshRunnerUpdates: true,
      })) as EnvironmentHealthSnapshot;

      expect(probeMock).toHaveBeenCalledWith({
        connectedStorefronts: ['steam'],
        forceFresh: true,
        forceRefreshRunnerUpdates: true,
      });
      expect(fallbackSnap.components.runner_crossover_preview_arm64).toBeDefined();
      expect(fallbackSnap.components.runner_crossover_preview_arm64?.id).toBe(
        'runner_crossover_preview_arm64'
      );

      const cancelHandler = handlers.get('launcher:cancel-compat-layer-op');
      expect(cancelHandler).toBeDefined();
      await cancelHandler!(null, '  RUNNER_CROSSOVER_PREVIEW_ARM64 ');
      expect(mockEngine.cancelCompatibilityLayerOperation).toHaveBeenCalledWith(
        'crossover_preview_arm64'
      );
    });
  });

  describe('F9 — Service Sync, forceFresh Deduplication & Launch Policy Preview', () => {
    it('preserves forceFresh across in-flight probe calls and triggers post-mutation sync hooks with synthetic terminal progress', async () => {
      const origWindow = (globalThis as any).window;
      const progressEvents: CompatibilityRunnerProgressEvent[] = [];
      let progressListener: ((evt: CompatibilityRunnerProgressEvent) => void) | null = null;
      const probeMock = vi.fn(async (opts?: { forceFresh?: boolean }) =>
        makeSnapshot({
          installedRunners: opts?.forceFresh ? ['crossover', 'crossover_preview_arm64'] : ['crossover'],
        })
      );

      (globalThis as any).window = {
        electronAPI: {
          probeEnvironmentHealth: probeMock,
          getCompatibilityLayers: vi.fn(async () => ({ layers: [] })),
          checkCompatibilityLayerUpdates: vi.fn(async () => ({ updates: {} })),
          onCompatibilityRunnerProgress: vi.fn((cb: (evt: CompatibilityRunnerProgressEvent) => void) => {
            progressListener = cb;
            return () => {
              progressListener = null;
            };
          }),
          installCompatibilityLayer: vi.fn(async () => {
            progressListener?.({
              runnerType: 'crossover_preview_arm64',
              operation: 'install',
              phase: 'downloading',
              progressPercent: 42,
              message: 'Downloading arm64 build...',
              updatedAt: new Date().toISOString(),
            });
            return {
              success: true,
              runnerType: 'crossover_preview_arm64',
              installed: true,
              layers: [makeLayer('crossover_preview_arm64', tmpRoot)],
            };
          }),
          updateCompatibilityLayer: vi.fn(async () => {
            progressListener?.({
              runnerType: 'crossover_preview_arm64',
              operation: 'update',
              phase: 'downloading',
              progressPercent: 50,
              message: 'Updating arm64 build...',
              updatedAt: new Date().toISOString(),
            });
            throw new Error('Network dropped');
          }),
        },
      };

      try {
        const lSvc = new LauncherService();
        const envSvc = new EnvironmentSetupService();
        const unsubscribe = lSvc.onRunnerProgress((evt) => progressEvents.push(evt));
        const unhook = lSvc.registerPostRunnerMutationSyncHook(async () => {
          await envSvc.probeHealth(undefined, { forceFresh: true });
        });

        // Concurrent in-flight probe + queued forceFresh probe
        const p1 = envSvc.probeHealth(['steam']);
        const p2 = envSvc.probeHealth(['steam'], { forceFresh: true });
        const [, snap2] = await Promise.all([p1, p2]);
        expect(probeMock).toHaveBeenCalledTimes(2);
        expect(probeMock.mock.calls[1]?.[0]?.forceFresh).toBe(true);
        expect(snap2.components.runner_crossover_preview_arm64?.status).toBe('ready');

        const installRes = await lSvc.installCompatibilityLayer('crossover_preview_arm64', 'auto', {
          authenticateOnly: true,
        });
        expect(installRes.success).toBe(true);
        expect(progressEvents.some((e) => e.phase === 'completed')).toBe(true);
        expect((globalThis as any).window.electronAPI.checkCompatibilityLayerUpdates).toHaveBeenCalled();
        expect(envSvc.getLastSnapshot()?.components.runner_crossover_preview_arm64?.status).toBe(
          'ready'
        );

        const updateErrRes = await lSvc.updateCompatibilityLayer('crossover_preview_arm64', {
          authenticateOnly: true,
        });
        expect(updateErrRes.success).toBe(false);
        expect(updateErrRes.error).toContain('Network dropped');
        expect(progressEvents.some((e) => e.phase === 'failed')).toBe(true);

        unsubscribe();
        unhook();
      } finally {
        (globalThis as any).window = origWindow;
      }
    });

    it('includes crossover_preview_arm64 descriptor and resolves isInstalled cleanly without explicit effPlatform', () => {
      const desc = COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === 'crossover_preview_arm64');
      expect(desc).toBeDefined();
      expect(desc?.label).toBe('CrossOver Preview (arm64 / FEX)');
      expect(desc?.previewBranch).toBe('arm64');
      expect(desc?.defaultBottleName).toBe('OneLauncher-arm64');
      expect(desc?.requiresAppleSilicon).toBe(true);

      const game = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Arm64 Direct Caller Test',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Game'),
            executablePath: path.join(tmpRoot, 'Games/Game/Game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      const preview = buildEffectiveLaunchModePreview({
        game,
        preferredPlatformId: 'steam',
        effPlatform: undefined,
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        draftConfig: {
          launchMethod: 'auto',
          compatibilityLayer: 'crossover_preview_arm64',
        },
        layers: [makeLayer('crossover_preview_arm64', tmpRoot)],
        globalStorefrontLifecycle: DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.storefrontClientLifecycle,
      });

      expect(preview.isInstalled).toBe(true);
      expect(preview.visibleSections.crossoverRendering).toBe(true);
      expect(preview.detectedBuildType).toBe('windows_exe_on_mac');
      expect(preview.modeNotes.auto?.dynamicDesc).toContain('CrossOver Preview (arm64 / FEX)');
    });
  });

  describe('F10 — Setup Wizard, Launch Config, GameInstallModal, WCAG 2.2 AA & Portability', () => {
    it('gates arm64 runner visibility by hostArch, shows bottle arch badges & warnings, and preserves custom bottle names', async () => {
      const arm64Snap = makeSnapshot({ hostArch: 'arm64' });
      const arm64Step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: arm64Snap,
        chosenRunner: 'crossover_preview_arm64',
        onSelectRunner: vi.fn(),
        bottleMode: 'reuse_existing',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
      });
      const arm64Tree = arm64Step.render();
      expect(findByTestId(arm64Tree, 'setup-runner-crossover-preview')).toBeDefined();
      expect(findByTestId(arm64Tree, 'setup-runner-crossover-preview-arm64')).toBeDefined();
      const intelBottleBtn = findByTestId(arm64Tree, 'setup-existing-bottle-OneLauncher');
      const arm64BottleBtn = findByTestId(arm64Tree, 'setup-existing-bottle-OneLauncher-arm64');
      expect(intelBottleBtn).toBeDefined();
      expect(getTextContent(intelBottleBtn!)).toContain('Intel / win64');
      expect(arm64BottleBtn).toBeDefined();
      expect(getTextContent(arm64BottleBtn!)).toContain('arm64 / FEX');
      expect(findByTestId(arm64Tree, 'setup-bottle-arch-warning')).toBeDefined();
      arm64Step.unmount();

      const x64Snap = makeSnapshot({
        hostArch: 'x64',
        installedRunners: ['crossover', 'crossover_preview'],
      });
      const x64Step = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: x64Snap,
        chosenRunner: 'crossover',
        onSelectRunner: vi.fn(),
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
      });
      expect(findByTestId(x64Step.render(), 'setup-runner-crossover-preview-arm64')).toBeUndefined();
      x64Step.unmount();

      // Custom bottle names are not overwritten when toggling runners inside SystemSetupWizardModal
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(arm64Snap);
      vi.spyOn(environmentSetupService, 'probeHealth').mockResolvedValue(arm64Snap);
      vi.spyOn(environmentSetupService, 'getWizardState').mockReturnValue({
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
      });

      const wizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      let wTree = wizard.render();
      await Promise.resolve();
      wTree = wizard.render();

      const customInput = findElements(
        wTree,
        (el) => el.type === 'input' && el.props?.['data-testid'] === 'setup-bottle-name-input'
      )[0];
      expect(customInput).toBeDefined();
      customInput.props.onChange({ target: { value: 'MyCustomBottle' } });
      wTree = wizard.render();

      const arm64Card = findByTestId(wTree, 'setup-runner-crossover-preview-arm64');
      expect(arm64Card).toBeDefined();
      arm64Card!.props.onClick();
      wTree = wizard.render();

      const updatedInput = findElements(
        wTree,
        (el) => el.type === 'input' && el.props?.['data-testid'] === 'setup-bottle-name-input'
      )[0];
      expect(updatedInput.props.value).toBe('MyCustomBottle');
      wizard.unmount();
    });

    it('supports GuidedClientSignInStep for crossover_preview_arm64 and Launch Config auth/error/bottle-arch UX', async () => {
      const guided = createDomain12DeepRenderer(GuidedClientSignInStep, {
        snapshot: makeSnapshot({ hostArch: 'arm64', pendingSteamLogin: true }),
        chosenRunner: 'crossover_preview_arm64',
        bottleName: 'OneLauncher-arm64',
        selectedIds: new Set<EnvironmentComponentId>(['host_steam']),
        activeGuidedLoginTarget: null,
        autoCloseOnSuccess: true,
        onToggleAutoCloseOnSuccess: vi.fn(),
        onGuidedLoginCompleted: vi.fn(),
      });
      const guidedTree = guided.render();
      expect(getTextContent(guidedTree)).toContain('Steam (Mac)');
      expect(getTextContent(guidedTree)).toContain('Sign in');
      guided.unmount();

      // Launch Config renders arm64 option on Apple Silicon, dynamic bottlesDir placeholder, mismatch banner, and clears progress on failure
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: {
          OneLauncher: {
            wineArch: 'win64',
          },
        },
      });
      const arm64EmptyLayer = makeLayer('crossover_preview_arm64', tmpRoot, { availableBottles: [] });
      const updateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview_arm64',
        installed: true,
        installedVersion: '27.0.0',
        installedDisplayVersion: '27.0.0 (Preview 20261111)',
        updateAvailable: false,
        authRequired: true,
        canAutoUpdate: true,
        checkedAt: '2026-11-18T00:00:00.000Z',
      };
      const game = makeCanonicalGameFixture({
        id: 'steam-1091500',
        title: 'Launch Config arm64 Test',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/TestGame'),
            executablePath: path.join(tmpRoot, 'Games/TestGame/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([arm64Layer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([arm64Layer]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
        crossover_preview_arm64: updateInfo,
      });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({
        crossover_preview_arm64: updateInfo,
      });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher', // x64 mismatch!
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Launch Config arm64 Test',
        installPath: path.join(tmpRoot, 'Games/TestGame'),
        executablePath: path.join(tmpRoot, 'Games/TestGame/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({ hostArch: 'arm64' })
      );

      const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let mTree = modal.render();
      await Promise.resolve();
      mTree = modal.render();

      expect(findByTestId(mTree, 'compat-bottle-arch-mismatch-warning')).toBeDefined();

      // Re-render with zero existing bottles to inspect dynamic bottlesDir placeholder
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([arm64EmptyLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([arm64EmptyLayer]);
      const emptyModal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let emptyTree = emptyModal.render();
      await Promise.resolve();
      emptyTree = emptyModal.render();

      const winePrefixInput = findElements(
        emptyTree,
        (el) => el.type === 'input' && typeof el.props?.placeholder === 'string' && el.props.placeholder.includes('BottlesArm64')
      )[0];
      expect(winePrefixInput).toBeDefined();
      expect(winePrefixInput.props.placeholder).toBe(
        formatUserFacingPath(path.join(arm64EmptyLayer.bottlesDir!, '...'))
      );
      emptyModal.unmount();

      // Well-formed JSX / unique IDs audit on rendered markup
      const markup = renderToStaticMarkup(mTree as React.ReactElement);
      const parseErrors: string[] = [];
      new XmlDomParser({
        errorHandler: {
          warning: () => {},
          error: (msg: string) => parseErrors.push(msg),
          fatalError: (msg: string) => parseErrors.push(msg),
        },
      }).parseFromString(`<div>${markup}</div>`, 'text/html');
      expect(parseErrors).toEqual([]);

      modal.unmount();
    });

    it('renders GameInstallModal with arm64 runner/bottle defaults and hides unavailable runners', async () => {
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, { availableBottles: [] });
      const game = makeCanonicalGameFixture({
        id: 'steam-arm64-install',
        title: 'Arm64 Install Modal Game',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([arm64Layer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([arm64Layer]);
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '1091500',
        defaultInstallDir: '~/Games/Arm64Game',
        availableInstallDirs: ['~/Games/Arm64Game'],
        canDirectDownload: true,
        isCrossPlatformBottleInstall: true,
        availableInstallers: [
          { id: 'win-64', name: 'Windows 64-bit', label: 'Windows 64-bit', os: 'windows' },
        ],
      });
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({
          hostArch: 'arm64',
          installedRunners: ['crossover_preview_arm64'],
        })
      );

      const installModal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });

      let tree = installModal.render();
      await Promise.resolve();
      await Promise.resolve();
      tree = installModal.render();

      const text = getTextContent(tree);
      expect(text).toContain('CrossOver Preview (arm64 / FEX)');
      expect(text).toContain('OneLauncher-arm64');
      installModal.unmount();
    });
  });

  describe('Iteration 2 Remediation Regressions (IPC Hardening, Cache Isolation, Services & UI)', () => {
    it('Challenger 1 #1: launcher:detect-compat-layers and launcher:check-compat-updates strip all untrusted renderer options', async () => {
      expect(
        launcherIpcHandlers.sanitizeCompatQueryOptions({
          mockFeeds: { crossover_preview_arm64: '<rss/>' },
          previewCandidateUrls: ['http://127.0.0.1:9999/evil.zip'],
          previewPortalHtml: '<a href="http://127.0.0.1/evil.zip">evil</a>',
          allowLoopbackInstallerUrls: true,
          customApplicationsDir: '/tmp/evil-apps',
          applicationsDirs: ['/tmp/evil-apps'],
          layers: [{ type: 'crossover_preview_arm64', version: '1' }],
          arch: 'x64',
          darwinKernelMajor: 20,
          skipNetwork: true,
          allowVersionSubprocess: true,
          homedir: tmpRoot,
        })
      ).toEqual({});

      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const mockIpcMain = {
        handle: vi.fn((ch: string, fn: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(ch, fn);
        }),
        removeHandler: vi.fn(),
      };
      const detectSpy = vi.fn(() => []);
      const checkSpy = vi.fn(async () => ({}));
      launcherIpcHandlers.registerLauncherIpcHandlers({
        ipcMain: mockIpcMain,
        launcherEngine: {
          detectCompatibilityLayers: detectSpy,
          checkCompatibilityLayerUpdates: checkSpy,
        },
        electronApp: { getPath: () => tmpRoot },
        browserWindowClass: { getAllWindows: () => [] },
        shellApi: { openExternal: vi.fn() },
        dialogApi: { showOpenDialog: vi.fn() },
        getMainWindow: () => null,
      });

      const detectHandler = handlers.get('launcher:detect-compat-layers')!;
      const checkHandler = handlers.get('launcher:check-compat-updates')!;

      await detectHandler(null, {
        customApplicationsDir: '/tmp/evil',
        applicationsDirs: ['/tmp/evil'],
        arch: 'x64',
        homedir: '/Users/evil',
        execFileFn: 'injected',
      });
      expect(detectSpy).toHaveBeenCalledWith({});

      await checkHandler(null, {
        mockFeeds: { crossover_preview_arm64: 'https://attacker.invalid/feed.xml' },
        previewCandidateUrls: ['http://127.0.0.1:9999/crossover-preview-arm64-20990101.zip'],
        previewPortalHtml: '<a href="https://attacker.invalid/trojan.zip">dl</a>',
        allowLoopbackInstallerUrls: true,
        layers: [],
        arch: 'x64',
        darwinKernelMajor: 20,
        skipNetwork: true,
        allowVersionSubprocess: true,
      });
      expect(checkSpy).toHaveBeenCalledWith({});

      // Also verify end-to-end against real macNativeInstaller.checkCompatibilityLayerUpdates
      macNativeInstaller.clearCachedAuthenticatedPreviewUrl();
      const realCheckHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      launcherIpcHandlers.registerLauncherIpcHandlers({
        ipcMain: {
          handle: (ch: string, fn: (...args: unknown[]) => Promise<unknown>) =>
            realCheckHandlers.set(ch, fn),
          removeHandler: vi.fn(),
        },
        launcherEngine: {
          checkCompatibilityLayerUpdates: macNativeInstaller.checkCompatibilityLayerUpdates,
        },
        electronApp: { getPath: () => tmpRoot },
        browserWindowClass: { getAllWindows: () => [] },
        shellApi: { openExternal: vi.fn() },
        dialogApi: { showOpenDialog: vi.fn() },
        getMainWindow: () => null,
      });
      const realCheckHandler = realCheckHandlers.get('launcher:check-compat-updates')!;
      const realRes = (await realCheckHandler(null, {
        allowLoopbackInstallerUrls: true,
        previewCandidateUrls: ['http://127.0.0.1:9999/crossover-preview-arm64-20990101.zip'],
        layers: [],
      })) as Record<string, CompatibilityLayerUpdateInfo>;
      expect(realRes?.crossover_preview_arm64?.downloadUrl).not.toBe(
        'http://127.0.0.1:9999/crossover-preview-arm64-20990101.zip'
      );
      expect(
        macNativeInstaller.getCachedAuthenticatedPreviewUrl({
          previewBranch: 'arm64',
          allowCachedPreviewUrlInTest: true,
        })
      ).toBeNull();
    });

    it('Challenger 1 #2: authenticating/installing one Preview branch preserves sibling branch cached preview URL', async () => {
      macNativeInstaller.clearCachedAuthenticatedPreviewUrl();
      const stdUrl = 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip';
      const armUrl =
        'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip';
      macNativeInstaller.setCachedAuthenticatedPreviewUrl(stdUrl, { previewBranch: 'standard' });

      const appsDir = path.join(tmpRoot, 'Applications');
      fs.mkdirSync(appsDir, { recursive: true });

      const installRes = await macNativeInstaller.installCompatibilityLayer(
        { runnerType: 'crossover_preview_arm64', mode: 'direct', authenticateOnly: true },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: tmpRoot,
          customApplicationsDir: appsDir,
          skipProcessCheck: true,
          capturePreviewDownloadFn: async () => ({
            authenticated: true,
            downloadUrl: armUrl,
          }),
        }
      );
      expect(installRes.success).toBe(true);
      expect(installRes.authenticated).toBe(true);

      expect(
        macNativeInstaller.getCachedAuthenticatedPreviewUrl({
          previewBranch: 'standard',
          allowCachedPreviewUrlInTest: true,
        })
      ).toBe(stdUrl);
      expect(
        macNativeInstaller.getCachedAuthenticatedPreviewUrl({
          previewBranch: 'arm64',
          allowCachedPreviewUrlInTest: true,
        })
      ).toBe(armUrl);
      macNativeInstaller.clearCachedAuthenticatedPreviewUrl();
    });

    it('Challenger 1 #3 & #4: probeHealth queues forceRefreshRunnerUpdates behind in-flight probe and switchToStableCrossOver keys runnerUpdates by updateInfo.runnerType', async () => {
      const origWindow = (globalThis as any).window;
      let releaseFirstProbe!: (s: EnvironmentHealthSnapshot) => void;
      const firstProbePromise = new Promise<EnvironmentHealthSnapshot>((resolve) => {
        releaseFirstProbe = resolve;
      });
      const probeCalls: Array<{ connectedStorefronts?: string[]; forceFresh?: boolean; forceRefreshRunnerUpdates?: boolean }> = [];
      const probeMock = vi.fn((opts: { connectedStorefronts?: string[]; forceFresh?: boolean; forceRefreshRunnerUpdates?: boolean }) => {
        probeCalls.push(opts);
        if (probeCalls.length === 1) {
          return firstProbePromise;
        }
        return Promise.resolve(makeSnapshot({ hostArch: 'arm64', installedRunners: ['crossover', 'crossover_preview_arm64'] }));
      });

      const stableUpdateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover',
        installed: true,
        installedVersion: '26.2.0',
        updateAvailable: false,
        canAutoUpdate: true,
        checkedAt: '2026-11-18T00:00:00.000Z',
      };

      (globalThis as any).window = {
        electronAPI: {
          probeEnvironmentHealth: probeMock,
          getCompatibilityLayers: vi.fn(async () => ({ layers: [] })),
          checkCompatibilityLayerUpdates: vi.fn(async () => ({})),
          onCompatibilityRunnerProgress: vi.fn(() => () => {}),
          updateCompatibilityLayer: vi.fn(async () => ({
            success: true,
            runnerType: 'crossover_preview',
            updated: true,
            detectedLayers: [makeLayer('crossover', tmpRoot)],
            updateInfo: stableUpdateInfo,
          })),
        },
      };

      try {
        const envSvc = new EnvironmentSetupService();
        const p1 = envSvc.probeHealth(['steam']);
        const p2 = envSvc.probeHealth(['steam'], { forceRefreshRunnerUpdates: true });
        releaseFirstProbe(makeSnapshot({ hostArch: 'arm64', installedRunners: ['crossover'] }));
        await Promise.all([p1, p2]);

        expect(probeCalls).toHaveLength(2);
        expect(probeCalls[1]).toEqual({
          connectedStorefronts: ['steam'],
          forceRefreshRunnerUpdates: true,
        });

        const lSvc = new LauncherService();
        await lSvc.updateCompatibilityLayer('crossover_preview', {
          switchToStableCrossOver: true,
        });
        const updates = lSvc.getRunnerUpdates();
        expect(updates.crossover).toEqual(stableUpdateInfo);
        expect(updates.crossover_preview).toBeUndefined();
      } finally {
        (globalThis as any).window = origWindow;
      }
    });

    it('Challenger 2 #1 & #3: Setup Wizard plans ensure_bottle + bottle_steam when creating OneLauncher-arm64 over existing Intel bottle, and rejects persisted -arm64 bottle on x64', async () => {
      // 2 #1: Existing Intel win64 OneLauncher bottle with Steam -> bottle_default & bottle_steam are ready
      const intelBottleOnlySnap = makeSnapshot({
        hostArch: 'arm64',
        installedRunners: ['crossover'],
        availableBottles: [
          {
            name: 'OneLauncher',
            path: path.join(tmpRoot, 'CrossOver/Bottles/OneLauncher'),
            runnerType: 'crossover',
            wineArch: 'win64',
            bottleArch: 'win64',
            hasSteam: true,
            hasGogGalaxy: false,
            hasEpicLauncher: false,
            isSandboxed: false,
          },
        ],
      });
      intelBottleOnlySnap.components.bottle_default.status = 'ready';
      intelBottleOnlySnap.components.bottle_steam.status = 'ready';

      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(intelBottleOnlySnap);
      vi.spyOn(environmentSetupService, 'probeHealth').mockResolvedValue(intelBottleOnlySnap);
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue({
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
      });
      vi.spyOn(environmentSetupService, 'getWizardState').mockReturnValue({
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
      });

      const wizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      let wTree = wizard.render();
      await Promise.resolve();
      await Promise.resolve();
      wTree = wizard.render();

      const armCard = findByTestId(wTree, 'setup-runner-crossover-preview-arm64');
      expect(armCard).toBeDefined();
      armCard!.props.onClick();
      wTree = wizard.render();

      // Advance compatibility -> clients -> summary
      findByTestId(wTree, 'setup-next-step-btn')!.props.onClick();
      wTree = wizard.render();
      findByTestId(wTree, 'setup-next-step-btn')!.props.onClick();
      wTree = wizard.render();

      expect(findByTestId(wTree, 'planned-task-bottle_default-ensure_bottle')).toBeDefined();
      expect(findByTestId(wTree, 'planned-task-bottle_steam-install_client')).toBeDefined();
      wizard.unmount();

      // Also check reuse_existing on compatible bottle still produces 0 tasks (preserves existing wizard tests)
      const reuseTasks = buildProvisioningTasksFromSelection({
        snapshot: intelBottleOnlySnap,
        selectedIds: new Set(['runner_crossover', 'bottle_default', 'bottle_steam']),
        chosenRunner: 'crossover',
        bottleMode: 'reuse_existing',
        bottleName: 'OneLauncher',
      });
      expect(reuseTasks).toHaveLength(0);

      // 2 #3: x64 host with persisted arm64 runner & OneLauncher-arm64 bottle falls back cleanly to OneLauncher
      const x64Snap = makeSnapshot({
        hostArch: 'x64',
        installedRunners: ['crossover', 'crossover_preview'],
        availableBottles: [],
      });
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(x64Snap);
      vi.spyOn(environmentSetupService, 'probeHealth').mockResolvedValue(x64Snap);
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue({
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
        preferredRunnerType: 'crossover_preview_arm64',
        preferredBottleName: 'OneLauncher-arm64',
      });
      vi.spyOn(environmentSetupService, 'getWizardState').mockReturnValue({
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
        preferredRunnerType: 'crossover_preview_arm64',
        preferredBottleName: 'OneLauncher-arm64',
      });

      const x64Wizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      let xTree = x64Wizard.render();
      await Promise.resolve();
      await Promise.resolve();
      xTree = x64Wizard.render();

      const xBottleInput = findElements(
        xTree,
        (el) => el.type === 'input' && el.props?.['data-testid'] === 'setup-bottle-name-input'
      )[0];
      expect(xBottleInput).toBeDefined();
      expect(xBottleInput.props.value).toBe('OneLauncher');
      x64Wizard.unmount();
    });

    it('Challenger 2 #2: GameInstallModal syncs runner on isOpen false->true, gates x64 arm64 option, disables incompatible bottles, and updates bottle on runner switch', async () => {
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          'OneLauncher-arm64': { wineArch: 'arm64' },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-transition-test',
        title: 'Transition Test',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([arm64Layer]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '1091500',
        defaultInstallDir: '~/Games/Transition',
        availableInstallDirs: ['~/Games/Transition'],
        canDirectDownload: true,
        isCrossPlatformBottleInstall: true,
        availableInstallers: [
          { id: 'win-64', name: 'Windows 64-bit', label: 'Windows 64-bit', os: 'windows' },
        ],
      });
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({ hostArch: 'arm64', installedRunners: ['crossover_preview_arm64'] })
      );

      // Mount closed first (isOpen: false)
      const modal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: false,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      modal.render();

      // Now open (isOpen: true)
      let openTree = modal.render({
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      await Promise.resolve();
      await Promise.resolve();
      openTree = modal.render({
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });

      const runnerSelect = findByTestId(openTree, 'preinstall-compat-runner');
      expect(runnerSelect).toBeDefined();
      expect(runnerSelect!.props.value).toBe('crossover_preview_arm64');

      const bottleSelect = findByTestId(openTree, 'preinstall-compat-bottle');
      expect(bottleSelect).toBeDefined();
      const bottleOptions = findElements(bottleSelect, (el) => el.type === 'option');
      const win64Option = bottleOptions.find((o) => o.props?.value === 'OneLauncher');
      const arm64Option = bottleOptions.find((o) => o.props?.value === 'OneLauncher-arm64');
      expect(win64Option?.props?.disabled).toBe(true);
      expect(arm64Option?.props?.disabled).toBe(false);
      // Default bottle label picks compatible OneLauncher-arm64 instead of incompatible OneLauncher
      expect(getTextContent(bottleOptions[0])).toContain('OneLauncher-arm64');
      modal.unmount();

      // Switch runner from crossover -> crossover_preview_arm64 clears/updates incompatible bottle
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          'OneLauncher-arm64': { wineArch: 'arm64' },
        },
      });
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([crossoverLayer, arm64Layer]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover',
        wineBottleName: 'OneLauncher',
      } as any);
      const switchModal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      let sTree = switchModal.render();
      await Promise.resolve();
      await Promise.resolve();
      sTree = switchModal.render();
      expect(findByTestId(sTree, 'preinstall-compat-bottle')!.props.value).toBe('OneLauncher');
      findByTestId(sTree, 'preinstall-compat-runner')!.props.onChange({
        target: { value: 'crossover_preview_arm64' },
      });
      sTree = switchModal.render();
      expect(findByTestId(sTree, 'preinstall-compat-bottle')!.props.value).toBe('OneLauncher-arm64');
      switchModal.unmount();

      // x64 host hides crossover_preview_arm64 from GameInstallModal
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      const x64Modal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      let xTree = x64Modal.render();
      await Promise.resolve();
      await Promise.resolve();
      xTree = x64Modal.render();
      const xRunnerOptions = findElements(
        findByTestId(xTree, 'preinstall-compat-runner'),
        (el) => el.type === 'option'
      ).map((o) => o.props?.value);
      expect(xRunnerOptions).not.toContain('crossover_preview_arm64');
      x64Modal.unmount();
    });

    it('Challenger 2 #4, #5, #6 & Reviewer Minors: uninstalled preview policy, selectRunnerArchive catch, x64 orphan normalization, available!==false count, and preview placeholder', async () => {
      // 2 #4: Uninstalled crossover_preview_arm64 selected with crossover installed -> no fallback to CrossOver / OneLauncher
      const game = makeCanonicalGameFixture({
        id: 'steam-policy-uninstalled',
        title: 'Policy Test',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Policy'),
            executablePath: path.join(tmpRoot, 'Games/Policy/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });
      const policy = buildEffectiveLaunchModePreview({
        game,
        preferredPlatformId: 'steam',
        effPlatform: undefined,
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        draftConfig: {
          launchMethod: 'auto',
          compatibilityLayer: 'crossover_preview_arm64',
        },
        layers: [makeLayer('crossover', tmpRoot, { availableBottles: ['OneLauncher'] })],
        globalStorefrontLifecycle: DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.storefrontClientLifecycle,
      });
      expect(policy.modeNotes.auto?.dynamicDesc).toContain('CrossOver Preview (arm64 / FEX)');
      expect(policy.modeNotes.auto?.dynamicDesc).toContain('OneLauncher-arm64');
      expect(policy.modeNotes.auto?.dynamicDesc).not.toContain('Bottle: "OneLauncher"');

      // 2 #5: selectRunnerArchive() rejection caught cleanly inside handleInstallRunnerFromArchive
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      vi.spyOn(launcherService, 'selectRunnerArchive').mockRejectedValue(
        new Error('Archive dialog crashed')
      );

      let latestForm: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const FormHarness: React.FC = () => {
        latestForm = useGameLaunchConfigForm({
          game,
          initialPlatformId: 'steam',
          isOpen: true,
          onClose: vi.fn(),
        });
        return React.createElement('div');
      };
      const formRenderer = createDomain12DeepRenderer(FormHarness, {});
      formRenderer.render();
      await Promise.resolve();
      await expect(latestForm!.handleInstallRunnerFromArchive()).resolves.toBeUndefined();
      formRenderer.render();
      expect(latestForm!.runnerActionFeedback?.text).toContain('Archive dialog crashed');
      formRenderer.unmount();

      // 2 #6 + Reviewer 2 Minor 2 + Reviewer 1 Minor:
      // x64 host normalizes saved crossover_preview_arm64, count excludes available===false, and uninstalled preview uses CrossOver Preview/Bottles placeholder
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      const unavailableArm64 = makeLayer('crossover_preview_arm64', tmpRoot, { available: false });
      const stdCrossOver = makeLayer('crossover', tmpRoot);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        stdCrossOver,
        unavailableArm64,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        stdCrossOver,
        unavailableArm64,
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher-arm64',
      } as any);

      const x64Modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let xTree = x64Modal.render();
      await Promise.resolve();
      xTree = x64Modal.render();
      const selectEl = findByTestId(xTree, 'compat-runner-select');
      const optionVals = findElements(selectEl, (el) => el.type === 'option').map(
        (o) => o.props?.value
      );
      expect(optionVals).toContain(selectEl!.props.value);
      expect(selectEl!.props.value).toBe('crossover');
      expect(getTextContent(xTree)).toContain('1 Detected on System');
      x64Modal.unmount();

      // Uninstalled preview placeholder check in CompatibilityLayerSection
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      const arm64Descriptor = COMPATIBILITY_RUNNER_DESCRIPTORS.find(
        (d) => d.type === 'crossover_preview_arm64'
      )!;
      const previewSection = createDomain12DeepRenderer(CompatibilityLayerSection, {
        isWindowsHost: false,
        detectedLayers: [],
        availableBottles: [],
        runnerUpdates: {},
        isCheckingUpdates: false,
        compatibilityLayer: 'crossover_preview_arm64',
        selectedRunnerDescriptor: arm64Descriptor,
        activeSecondaryBuildText: '',
        wineBottleName: '',
        winePrefixPath: '',
        crossoverGraphicsBackend: 'auto',
        crossoverD3DMetalVersion: 'auto',
        showD3DMetalVersionSelector: true,
        primaryD3DVer: '4',
        fallbackD3DVer: '3',
        isDlssSupportedBackend: true,
        isDxvkHudSupported: true,
        crossoverHighResolutionMode: undefined,
        crossoverDlss: false,
        preferredMaxFrameRate: undefined,
        metalfxSpatialUpscaleFactor: undefined,
        displayScalingMode: 'default',
        displayAspectRatio: 'default',
        virtualDesktopResolution: 'auto',
        emulateModeset: undefined,
        forceLargeAddressAware: undefined,
        wineMsync: true,
        wineEsync: false,
        metalHud: false,
        dxvkHud: false,
        activeDisplayMethod: 'compatibility_layer',
        preview: policy,
        isInstallingRunner: false,
        isUpdatingRunner: false,
        isRescanningRunners: false,
        runnerActionFeedback: null,
        runnerUpdateFeedback: null,
        onSelectCompatibilityLayer: vi.fn(),
        onChangeWineBottleName: vi.fn(),
        onChangeWinePrefixPath: vi.fn(),
        onBrowseWinePrefix: vi.fn(),
        onOpenBottleFolder: vi.fn(),
        onRescanLayers: vi.fn(),
        onChangeCrossoverGraphicsBackend: vi.fn(),
        onChangeCrossoverD3DMetalVersion: vi.fn(),
        onChangeCrossoverHighResolutionMode: vi.fn(),
        onToggleCrossoverDlss: vi.fn(),
        onChangePreferredMaxFrameRate: vi.fn(),
        onChangeMetalfxSpatialUpscaleFactor: vi.fn(),
        onChangeDisplayScalingMode: vi.fn(),
        onChangeDisplayAspectRatio: vi.fn(),
        onChangeVirtualDesktopResolution: vi.fn(),
        onChangeEmulateModeset: vi.fn(),
        onToggleForceLargeAddressAware: vi.fn(),
        onToggleWineMsync: vi.fn(),
        onToggleWineEsync: vi.fn(),
        onToggleMetalHud: vi.fn(),
        onToggleDxvkHud: vi.fn(),
        onInstallRunnerViaBrew: vi.fn(),
        onInstallRunnerFromArchive: vi.fn(),
        onCheckRunnerUpdates: vi.fn(),
        onUpdateRunner: vi.fn(),
        onSwitchToStableCrossOver: vi.fn(),
        onDownloadRunner: vi.fn(),
        onCancelRunnerOperation: vi.fn(),
      });
      const pTree = previewSection.render();
      const prefixInput = findElements(
        pTree,
        (el) =>
          el.type === 'input' &&
          typeof el.props?.placeholder === 'string' &&
          el.props.placeholder.includes('CrossOver Preview/Bottles')
      )[0];
      expect(prefixInput).toBeDefined();
      expect(prefixInput.props.placeholder).toBe(
        '~/Library/Application Support/CrossOver Preview/Bottles/...'
      );
      previewSection.unmount();
    });
  });

  describe('Iteration 3 Remediation Regressions (x64 Bottle Sanitization, Stale-Closure & Install Payload Parity)', () => {
    it('2B-EDGE: GameInstallModal sanitizes saved OneLauncher-arm64 bottle when crossover_preview_arm64 downgrades on x64 and preserves arm64 mismatch warning', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          'OneLauncher-arm64': { wineArch: 'arm64' },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-x64-bottle-sanitize',
        title: 'x64 Bottle Sanitize Game',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        arm64Layer,
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        preferredPlatformId: 'steam',
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher-arm64',
      } as any);
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '1091500',
        defaultInstallDir: '~/Games/Sanitize',
        availableInstallDirs: ['~/Games/Sanitize'],
        canDirectDownload: true,
        isCrossPlatformBottleInstall: true,
        availableInstallers: [
          { id: 'win-64', name: 'Windows 64-bit', label: 'Windows 64-bit', os: 'windows' },
        ],
      });
      vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        targetPath: path.join(tmpRoot, 'Games/Sanitize'),
        freeBytes: 200 * 1024 ** 3,
        usedBytes: 300 * 1024 ** 3,
        totalBytes: 500 * 1024 ** 3,
      });
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined as any);
      const installSpy = vi.spyOn(launcherService, 'startInstall').mockResolvedValue({
        success: true,
        task: { id: 'task-1' } as any,
      });

      const modal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      let tree = modal.render();
      await Promise.resolve();
      await Promise.resolve();
      tree = modal.render();

      const runnerSel = findByTestId(tree, 'preinstall-compat-runner');
      const bottleSel = findByTestId(tree, 'preinstall-compat-bottle');
      const bottleOpts = findElements(bottleSel, (el) => el.type === 'option').map(
        (o) => o.props?.value
      );
      expect(runnerSel!.props.value).toBe('crossover');
      expect(bottleOpts).toEqual(['', 'OneLauncher']);
      expect(bottleOpts).toContain(bottleSel!.props.value);
      expect(bottleSel!.props.value).toBe('OneLauncher');
      expect(findByTestId(tree, 'preinstall-bottle-arch-warning')).toBeUndefined();

      const startBtn = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
      )[0];
      expect(startBtn).toBeDefined();
      await startBtn.props.onClick();

      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          compatibilityLayer: 'crossover',
          wineBottleName: 'OneLauncher',
        }),
        'steam'
      );
      expect(installSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          compatibilityLayer: 'crossover',
          wineBottleName: 'OneLauncher',
        })
      );
      modal.unmount();

      // Verify arm64 host still shows preinstall-bottle-arch-warning when matching runner has explicit incompatible bottle in availableBottles
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        preferredPlatformId: 'steam',
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher',
      } as any);

      const armModal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      let armTree = armModal.render();
      await Promise.resolve();
      await Promise.resolve();
      armTree = armModal.render();

      expect(findByTestId(armTree, 'preinstall-compat-runner')!.props.value).toBe(
        'crossover_preview_arm64'
      );
      expect(findByTestId(armTree, 'preinstall-compat-bottle')!.props.value).toBe('OneLauncher');
      expect(findByTestId(armTree, 'preinstall-bottle-arch-warning')).toBeDefined();
      armModal.unmount();
    });

    it('Reviewer 2 Minor: GameInstallModal does not retain stale selectedCompatRunner closure across game switches', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher-arm64'],
        bottleDetails: { 'OneLauncher-arm64': { wineArch: 'arm64' } },
      });
      const gameA = makeCanonicalGameFixture({
        id: 'steam-game-a',
        title: 'Game A',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '101',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });
      const gameB = makeCanonicalGameFixture({
        id: 'steam-game-b',
        title: 'Game B',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '102',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        arm64Layer,
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockImplementation((id: string) =>
        id === gameA.id
          ? ({
              gameId: gameA.id,
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover_preview_arm64',
              wineBottleName: 'OneLauncher-arm64',
            } as any)
          : undefined
      );
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '101',
        defaultInstallDir: '~/Games/SwitchTest',
        availableInstallDirs: ['~/Games/SwitchTest'],
        canDirectDownload: true,
        isCrossPlatformBottleInstall: true,
        availableInstallers: [
          { id: 'win-64', name: 'Windows 64-bit', label: 'Windows 64-bit', os: 'windows' },
        ],
      });

      const modal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game: gameA,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      let tree = modal.render();
      await Promise.resolve();
      await Promise.resolve();
      tree = modal.render();
      expect(findByTestId(tree, 'preinstall-compat-runner')!.props.value).toBe(
        'crossover_preview_arm64'
      );

      // Close modal, then reopen for Game B (no saved config)
      modal.render({
        isOpen: false,
        game: gameA,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      tree = modal.render({
        isOpen: true,
        game: gameB,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      await Promise.resolve();
      await Promise.resolve();
      tree = modal.render({
        isOpen: true,
        game: gameB,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      expect(findByTestId(tree, 'preinstall-compat-runner')!.props.value).toBe('crossover');
      expect(findByTestId(tree, 'preinstall-compat-bottle')!.props.value).toBe('');
      modal.unmount();
    });

    it('4D: GameLaunchConfigModal / useGameLaunchConfigForm sanitizes orphan OneLauncher-arm64 bottle on x64 while preserving arm64 mismatch warning', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher-arm64'],
        bottleDetails: { 'OneLauncher-arm64': { wineArch: 'arm64' } },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-launch-cfg-4d',
        title: 'Launch Config 4D Test',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/LaunchCfg4D'),
            executablePath: path.join(tmpRoot, 'Games/LaunchCfg4D/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        arm64Layer,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        crossoverLayer,
        arm64Layer,
      ]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher-arm64',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Launch Config 4D Test',
        installPath: path.join(tmpRoot, 'Games/LaunchCfg4D'),
        executablePath: path.join(tmpRoot, 'Games/LaunchCfg4D/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({ hostArch: 'x64', installedRunners: ['crossover'] })
      );

      const x64Modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let xTree = x64Modal.render();
      await Promise.resolve();
      xTree = x64Modal.render();

      const runnerSelect = findByTestId(xTree, 'compat-runner-select');
      const bottleControl = findElements(
        xTree,
        (el) => el.props?.id === 'compat-target-bottle-control'
      )[0];
      const bottleOpts = findElements(bottleControl, (el) => el.type === 'option').map(
        (o) => o.props?.value
      );
      expect(runnerSelect!.props.value).toBe('crossover');
      expect(bottleOpts).toEqual(['', 'OneLauncher']);
      expect(bottleOpts).toContain(bottleControl.props.value);
      expect(bottleControl.props.value).toBe('');
      expect(findByTestId(xTree, 'compat-bottle-arch-mismatch-warning')).toBeUndefined();
      x64Modal.unmount();

      // Verify arm64 host still surfaces compat-bottle-arch-mismatch-warning when incompatible bottle is saved and present in availableBottles
      const arm64WithWin64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          'OneLauncher-arm64': { wineArch: 'arm64' },
        },
      });
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        arm64WithWin64Layer,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        crossoverLayer,
        arm64WithWin64Layer,
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher',
      } as any);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({ hostArch: 'arm64', installedRunners: ['crossover_preview_arm64'] })
      );

      const armModal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let armTree = armModal.render();
      await Promise.resolve();
      armTree = armModal.render();

      expect(findByTestId(armTree, 'compat-runner-select')!.props.value).toBe(
        'crossover_preview_arm64'
      );
      expect(findByTestId(armTree, 'compat-bottle-arch-mismatch-warning')).toBeDefined();
      armModal.unmount();
    });
  });

  describe('Iteration 4 Remediation Regressions (Runner Switch Cross-Layer Bottle, Empty-List Select Orphan, Cold-Cache Form & Standalone Section Downgrade)', () => {
    it('Probe 2B-EDGE-D / 5C: GameInstallModal resets cross-layer CustomFex/CustomArm64 bottle on runner switch from crossover_preview_arm64 to crossover and submits clean payload', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher-arm64', 'CustomFex'],
        bottleDetails: {
          'OneLauncher-arm64': { wineArch: 'arm64' },
          CustomFex: { wineArch: 'arm64' },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-probe-2b-edge-d',
        title: 'Probe 2B-EDGE-D Game',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        arm64Layer,
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        preferredPlatformId: 'steam',
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'CustomFex',
      } as any);
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '1091500',
        defaultInstallDir: '~/Games/Probe2BEDGED',
        availableInstallDirs: ['~/Games/Probe2BEDGED'],
        canDirectDownload: true,
        isCrossPlatformBottleInstall: true,
        availableInstallers: [
          { id: 'win-64', name: 'Windows 64-bit', label: 'Windows 64-bit', os: 'windows' },
        ],
      });
      vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        targetPath: path.join(tmpRoot, 'Games/Probe2BEDGED'),
        freeBytes: 200 * 1024 ** 3,
        usedBytes: 300 * 1024 ** 3,
        totalBytes: 500 * 1024 ** 3,
      });
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined as any);
      const installSpy = vi.spyOn(launcherService, 'startInstall').mockResolvedValue({
        success: true,
        task: { id: 'task-2b-d' } as any,
      });

      const modal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      let tree = modal.render();
      await Promise.resolve();
      await Promise.resolve();
      tree = modal.render();

      expect(findByTestId(tree, 'preinstall-compat-runner')!.props.value).toBe(
        'crossover_preview_arm64'
      );
      expect(findByTestId(tree, 'preinstall-compat-bottle')!.props.value).toBe('CustomFex');

      findByTestId(tree, 'preinstall-compat-runner')!.props.onChange({
        target: { value: 'crossover' },
      });
      tree = modal.render();

      const bottleSel = findByTestId(tree, 'preinstall-compat-bottle')!;
      const bottleOpts = findElements(bottleSel, (el) => el.type === 'option').map(
        (o) => o.props?.value
      );
      expect(bottleOpts).toEqual(['', 'OneLauncher']);
      expect(bottleOpts).toContain(bottleSel.props.value);
      expect(bottleSel.props.value).toBe('OneLauncher');
      expect(findByTestId(tree, 'preinstall-bottle-arch-warning')).toBeUndefined();

      const startBtn = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
      )[0];
      await startBtn.props.onClick();

      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          compatibilityLayer: 'crossover',
          wineBottleName: 'OneLauncher',
        }),
        'steam'
      );
      expect(installSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          compatibilityLayer: 'crossover',
          wineBottleName: 'OneLauncher',
        })
      );
      modal.unmount();

      // Also verify runner switch when target crossover layer has availableBottles: [] (clears CustomArm64 to '')
      const emptyCrossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: [],
      });
      const customArm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['CustomArm64'],
        bottleDetails: { CustomArm64: { wineArch: 'arm64' } },
      });
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        emptyCrossoverLayer,
        customArm64Layer,
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        preferredPlatformId: 'steam',
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'CustomArm64',
      } as any);
      saveSpy.mockClear();
      installSpy.mockClear();

      const emptySwitchModal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      let eTree = emptySwitchModal.render();
      await Promise.resolve();
      await Promise.resolve();
      eTree = emptySwitchModal.render();

      findByTestId(eTree, 'preinstall-compat-runner')!.props.onChange({
        target: { value: 'crossover' },
      });
      eTree = emptySwitchModal.render();
      const emptyBottleSel = findByTestId(eTree, 'preinstall-compat-bottle')!;
      expect(emptyBottleSel.props.value).toBe('');

      const emptyStartBtn = findElements(
        eTree,
        (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
      )[0];
      await emptyStartBtn.props.onClick();
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          compatibilityLayer: 'crossover',
          wineBottleName: undefined,
        }),
        'steam'
      );
      expect(installSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          compatibilityLayer: 'crossover',
          wineBottleName: undefined,
        })
      );
      emptySwitchModal.unmount();
    });

    it('Probe 2B-EDGE-C: GameInstallModal clears orphan wineBottleName on x64 when crossover availableBottles is [] while preserving arm64 mismatch warnings', async () => {
      const crossoverEmptyLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: [],
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          'OneLauncher-arm64': { wineArch: 'arm64' },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-probe-2b-edge-c',
        title: 'Probe 2B-EDGE-C Game',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverEmptyLayer,
        arm64Layer,
      ]);
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '1091500',
        defaultInstallDir: '~/Games/Probe2BEDGEC',
        availableInstallDirs: ['~/Games/Probe2BEDGEC'],
        canDirectDownload: true,
        isCrossPlatformBottleInstall: true,
        availableInstallers: [
          { id: 'win-64', name: 'Windows 64-bit', label: 'Windows 64-bit', os: 'windows' },
        ],
      });
      vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        targetPath: path.join(tmpRoot, 'Games/Probe2BEDGEC'),
        freeBytes: 200 * 1024 ** 3,
        usedBytes: 300 * 1024 ** 3,
        totalBytes: 500 * 1024 ** 3,
      });
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined as any);
      const installSpy = vi.spyOn(launcherService, 'startInstall').mockResolvedValue({
        success: true,
        task: { id: 'task-2b-c' } as any,
      });

      for (const orphanBottle of ['OneLauncher-arm64', 'MyDeletedCustomBottle']) {
        vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
          gameId: game.id,
          preferredPlatformId: 'steam',
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover',
          wineBottleName: orphanBottle,
        } as any);
        saveSpy.mockClear();
        installSpy.mockClear();

        const modal = createDomain12DeepRenderer(GameInstallModal, {
          isOpen: true,
          game,
          initialPlatformId: 'steam',
          onClose: vi.fn(),
          onInstallStarted: vi.fn(),
        });
        let tree = modal.render();
        await Promise.resolve();
        await Promise.resolve();
        tree = modal.render();

        const bottleSel = findByTestId(tree, 'preinstall-compat-bottle')!;
        const bottleOpts = findElements(bottleSel, (el) => el.type === 'option').map(
          (o) => o.props?.value
        );
        expect(bottleOpts).toEqual(['']);
        expect(bottleSel.props.value).toBe('');
        expect(findByTestId(tree, 'preinstall-bottle-arch-warning')).toBeUndefined();

        const startBtn = findElements(
          tree,
          (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
        )[0];
        await startBtn.props.onClick();
        expect(saveSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            compatibilityLayer: 'crossover',
            wineBottleName: undefined,
          }),
          'steam'
        );
        expect(installSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            compatibilityLayer: 'crossover',
            wineBottleName: undefined,
          })
        );
        modal.unmount();
      }

      // Preserve arm64 mismatch warning when savedRunner === resolvedRunner and bottle exists in availableBottles
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        preferredPlatformId: 'steam',
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher',
      } as any);

      const armModal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
        onInstallStarted: vi.fn(),
      });
      let armTree = armModal.render();
      await Promise.resolve();
      await Promise.resolve();
      armTree = armModal.render();

      expect(findByTestId(armTree, 'preinstall-compat-bottle')!.props.value).toBe('OneLauncher');
      expect(findByTestId(armTree, 'preinstall-bottle-arch-warning')).toBeDefined();
      armModal.unmount();
    });

    it('Probe 4D-D: useGameLaunchConfigForm sanitizes CustomFex on cold-cache async layer detection on x64 while preserving free-text input when availableBottles is []', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher-arm64', 'CustomFex'],
        bottleDetails: {
          'OneLauncher-arm64': { wineArch: 'arm64' },
          CustomFex: { wineArch: 'arm64' },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-probe-4d-d',
        title: 'Probe 4D-D Game',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Probe4DD'),
            executablePath: path.join(tmpRoot, 'Games/Probe4DD/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        crossoverLayer,
        arm64Layer,
      ]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover',
        wineBottleName: 'CustomFex',
      } as any);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Probe 4D-D Game',
        installPath: path.join(tmpRoot, 'Games/Probe4DD'),
        executablePath: path.join(tmpRoot, 'Games/Probe4DD/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({ hostArch: 'x64', installedRunners: ['crossover'] })
      );

      let latestForm: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const FormHarness: React.FC = () => {
        latestForm = useGameLaunchConfigForm({
          game,
          initialPlatformId: 'steam',
          isOpen: true,
          onClose: vi.fn(),
        });
        return React.createElement('div');
      };
      const formRenderer = createDomain12DeepRenderer(FormHarness, {});
      formRenderer.render();
      await Promise.resolve();
      await Promise.resolve();
      formRenderer.render();

      expect(latestForm!.compatibilityLayer).toBe('crossover');
      expect(latestForm!.wineBottleName).toBe('');
      expect(latestForm!.hasUnsavedChanges).toBe(false);
      formRenderer.unmount();

      // Also verify modal DOM renders clean select without CustomFex
      const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let mTree = modal.render();
      await Promise.resolve();
      await Promise.resolve();
      mTree = modal.render();
      const bottleControl = findElements(
        mTree,
        (el) => el.props?.id === 'compat-target-bottle-control'
      )[0];
      const bottleOpts = findElements(bottleControl, (el) => el.type === 'option').map(
        (o) => o.props?.value
      );
      expect(bottleOpts).toEqual(['', 'OneLauncher']);
      expect(bottleControl.props.value).toBe('');
      expect(findByTestId(mTree, 'compat-bottle-arch-mismatch-warning')).toBeUndefined();
      modal.unmount();

      // Verify free-text <input> custom bottle is preserved when crossoverLayer has availableBottles: []
      const emptyCrossoverLayer = makeLayer('crossover', tmpRoot, { availableBottles: [] });
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        emptyCrossoverLayer,
        arm64Layer,
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover',
        wineBottleName: 'MyCustomBottle',
      } as any);
      const customModal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let cTree = customModal.render();
      await Promise.resolve();
      await Promise.resolve();
      cTree = customModal.render();
      const customInput = findElements(
        cTree,
        (el) => el.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(customInput.type).toBe('input');
      expect(customInput.props.value).toBe('MyCustomBottle');
      customModal.unmount();
    });

    it('Probe 4D-C: standalone CompatibilityLayerSection derives effective layer and bottles when downgraded on x64', () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher-arm64'],
        bottleDetails: { 'OneLauncher-arm64': { wineArch: 'arm64' } },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-probe-4d-c',
        title: 'Probe 4D-C Game',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Probe4DC'),
            executablePath: path.join(tmpRoot, 'Games/Probe4DC/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });
      const policy = buildEffectiveLaunchModePreview({
        game,
        preferredPlatformId: 'steam',
        effPlatform: undefined,
        hostPlatform: 'darwin',
        hostArch: 'x64',
        draftConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
        },
        layers: [crossoverLayer, arm64Layer],
        globalStorefrontLifecycle: DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.storefrontClientLifecycle,
      });

      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      const arm64Descriptor = COMPATIBILITY_RUNNER_DESCRIPTORS.find(
        (d) => d.type === 'crossover_preview_arm64'
      )!;
      const section = createDomain12DeepRenderer(CompatibilityLayerSection, {
        isWindowsHost: false,
        detectedLayers: [crossoverLayer, arm64Layer],
        activeLayer: arm64Layer,
        availableBottles: ['OneLauncher-arm64'],
        runnerUpdates: {},
        isCheckingUpdates: false,
        compatibilityLayer: 'crossover_preview_arm64',
        selectedRunnerDescriptor: arm64Descriptor,
        activeSecondaryBuildText: '',
        wineBottleName: 'OneLauncher-arm64',
        winePrefixPath: '',
        crossoverGraphicsBackend: 'auto',
        crossoverD3DMetalVersion: 'auto',
        showD3DMetalVersionSelector: true,
        primaryD3DVer: '4',
        fallbackD3DVer: '3',
        isDlssSupportedBackend: true,
        isDxvkHudSupported: true,
        crossoverHighResolutionMode: undefined,
        crossoverDlss: false,
        preferredMaxFrameRate: undefined,
        metalfxSpatialUpscaleFactor: undefined,
        displayScalingMode: 'default',
        displayAspectRatio: 'default',
        virtualDesktopResolution: 'auto',
        emulateModeset: undefined,
        forceLargeAddressAware: undefined,
        wineMsync: true,
        wineEsync: false,
        metalHud: false,
        dxvkHud: false,
        activeDisplayMethod: 'compatibility_layer',
        preview: policy,
        isInstallingRunner: false,
        isUpdatingRunner: false,
        isRescanningRunners: false,
        runnerActionFeedback: null,
        runnerUpdateFeedback: null,
        onSelectCompatibilityLayer: vi.fn(),
        onChangeWineBottleName: vi.fn(),
        onChangeWinePrefixPath: vi.fn(),
        onBrowseWinePrefix: vi.fn(),
        onOpenBottleFolder: vi.fn(),
        onRescanLayers: vi.fn(),
        onChangeCrossoverGraphicsBackend: vi.fn(),
        onChangeCrossoverD3DMetalVersion: vi.fn(),
        onChangeCrossoverHighResolutionMode: vi.fn(),
        onToggleCrossoverDlss: vi.fn(),
        onChangePreferredMaxFrameRate: vi.fn(),
        onChangeMetalfxSpatialUpscaleFactor: vi.fn(),
        onChangeDisplayScalingMode: vi.fn(),
        onChangeDisplayAspectRatio: vi.fn(),
        onChangeVirtualDesktopResolution: vi.fn(),
        onChangeEmulateModeset: vi.fn(),
        onToggleForceLargeAddressAware: vi.fn(),
        onToggleWineMsync: vi.fn(),
        onToggleWineEsync: vi.fn(),
        onToggleMetalHud: vi.fn(),
        onToggleDxvkHud: vi.fn(),
        onInstallRunnerViaBrew: vi.fn(),
        onInstallRunnerFromArchive: vi.fn(),
        onCheckRunnerUpdates: vi.fn(),
        onUpdateRunner: vi.fn(),
        onSwitchToStableCrossOver: vi.fn(),
        onDownloadRunner: vi.fn(),
        onCancelRunnerOperation: vi.fn(),
      });
      const tree = section.render();

      const runnerSelect = findByTestId(tree, 'compat-runner-select')!;
      const bottleControl = findElements(
        tree,
        (el) => el.props?.id === 'compat-target-bottle-control'
      )[0];
      const bottleOpts = findElements(bottleControl, (el) => el.type === 'option').map(
        (o) => o.props?.value
      );

      expect(runnerSelect.props.value).toBe('crossover');
      expect(bottleControl.props.value).toBe('');
      expect(bottleOpts).toEqual(['', 'OneLauncher']);
      expect(findByTestId(tree, 'compat-bottle-arch-mismatch-warning')).toBeUndefined();
      const installedVerText = getTextContent(findByTestId(tree, 'runner-installed-version')!);
      expect(installedVerText).toContain('CrossOver');
      expect(installedVerText).not.toContain('arm64 / FEX');
      section.unmount();
    });
  });

  describe('Iteration 5 Remediation Regressions (Cold-Cache Async Race & arm64 Orphan Select / Cross-Layer Warning)', () => {
    it('Probe 6B / 6B-bis: cold-cache detectCompatibilityLayers() resolution does not clobber user runner/bottle edits or platform switches', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const previewLayer = makeLayer('crossover_preview', tmpRoot, {
        availableBottles: ['OneLauncher', 'PreviewBottle'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          PreviewBottle: { wineArch: 'win64' },
        },
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher-arm64'],
        bottleDetails: { 'OneLauncher-arm64': { wineArch: 'arm64' } },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-probe-6b',
        title: 'Probe 6B Race Game',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Probe6B'),
            executablePath: path.join(tmpRoot, 'Games/Probe6B/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
          {
            platformId: 'epic',
            platformGameId: 'epic-probe-6b',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Probe6BEpic'),
            executablePath: path.join(tmpRoot, 'Games/Probe6BEpic/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Probe 6B Race Game',
        installPath: path.join(tmpRoot, 'Games/Probe6B'),
        executablePath: path.join(tmpRoot, 'Games/Probe6B/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      // Part A (Probe 6B-bis): arm64 with no saved config, user picks crossover_preview_arm64 + OneLauncher-arm64 before detect resolves
      let resolveArm64Detect!: (layers: CompatibilityLayerInfo[]) => void;
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockImplementation(
        () =>
          new Promise<CompatibilityLayerInfo[]>((resolve) => {
            resolveArm64Detect = resolve;
          })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({ hostArch: 'arm64', installedRunners: ['crossover', 'crossover_preview_arm64'] })
      );
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined as any);

      const armModal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let armTree = armModal.render();
      findByTestId(armTree, 'compat-runner-select')!.props.onChange({
        target: { value: 'crossover_preview_arm64' },
      });
      armTree = armModal.render();
      findElements(armTree, (el) => el.props?.id === 'compat-target-bottle-control')[0].props.onChange({
        target: { value: 'OneLauncher-arm64' },
      });
      armTree = armModal.render();

      resolveArm64Detect([crossoverLayer, arm64Layer]);
      await Promise.resolve();
      await Promise.resolve();
      armTree = armModal.render();

      expect(findByTestId(armTree, 'compat-runner-select')!.props.value).toBe(
        'crossover_preview_arm64'
      );
      expect(
        findElements(armTree, (el) => el.props?.id === 'compat-target-bottle-control')[0].props.value
      ).toBe('OneLauncher-arm64');

      const armSaveBtn = findElements(
        armTree,
        (el) => el.type === 'button' && getTextContent(el).includes('Save Configuration')
      )[0];
      await armSaveBtn.props.onClick();
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          compatibilityLayer: 'crossover_preview_arm64',
          wineBottleName: 'OneLauncher-arm64',
        }),
        'steam'
      );
      armModal.unmount();

      // Part B (Probe 6B): x64 with host-unsupported saved crossover_preview_arm64, user picks crossover_preview + PreviewBottle before detect resolves
      let resolveX64Detect!: (layers: CompatibilityLayerInfo[]) => void;
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockImplementation(
        () =>
          new Promise<CompatibilityLayerInfo[]>((resolve) => {
            resolveX64Detect = resolve;
          })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'CustomFex',
      } as any);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({ hostArch: 'x64', installedRunners: ['crossover', 'crossover_preview'] })
      );
      saveSpy.mockClear();

      const x64Modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let x64Tree = x64Modal.render();
      findByTestId(x64Tree, 'compat-runner-select')!.props.onChange({
        target: { value: 'crossover_preview' },
      });
      x64Tree = x64Modal.render();
      findElements(x64Tree, (el) => el.props?.id === 'compat-target-bottle-control')[0].props.onChange({
        target: { value: 'PreviewBottle' },
      });
      x64Tree = x64Modal.render();

      resolveX64Detect([crossoverLayer, previewLayer]);
      await Promise.resolve();
      await Promise.resolve();
      x64Tree = x64Modal.render();

      expect(findByTestId(x64Tree, 'compat-runner-select')!.props.value).toBe('crossover_preview');
      expect(
        findElements(x64Tree, (el) => el.props?.id === 'compat-target-bottle-control')[0].props.value
      ).toBe('PreviewBottle');

      const x64SaveBtn = findElements(
        x64Tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Save Configuration')
      )[0];
      await x64SaveBtn.props.onClick();
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          compatibilityLayer: 'crossover_preview',
          wineBottleName: 'PreviewBottle',
        }),
        'steam'
      );
      x64Modal.unmount();

      // Part C: switching platform before detectCompatibilityLayers resolves prevents steam's autoLayer from clobbering epic
      let resolveSwitchDetect!: (layers: CompatibilityLayerInfo[]) => void;
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockImplementation(
        () =>
          new Promise<CompatibilityLayerInfo[]>((resolve) => {
            resolveSwitchDetect = resolve;
          })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockImplementation((_gId, platId) =>
        platId === 'epic'
          ? ({ launchMethod: 'compatibility_layer', compatibilityLayer: 'crossover_preview' } as any)
          : undefined
      );

      let latestForm: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const SwitchHarness: React.FC = () => {
        latestForm = useGameLaunchConfigForm({
          game,
          initialPlatformId: 'steam',
          isOpen: true,
          onClose: vi.fn(),
        });
        return React.createElement('div');
      };
      const switchRenderer = createDomain12DeepRenderer(SwitchHarness, {});
      switchRenderer.render();
      latestForm!.handleSelectStorefront('epic');
      switchRenderer.render();

      resolveSwitchDetect([crossoverLayer, previewLayer]);
      await Promise.resolve();
      await Promise.resolve();
      switchRenderer.render();

      expect(latestForm!.preferredPlatformId).toBe('epic');
      expect(latestForm!.compatibilityLayer).toBe('crossover_preview');
      switchRenderer.unmount();
    });

    it('Probe 6C & Reviewer 2 Finding 1: arm64 Launch Config clears orphan select bottles (warm & cold cache) while preserving in-list mismatch warnings and free-text cross-layer arch warning', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher-arm64', 'CustomFex'],
        bottleDetails: {
          'OneLauncher-arm64': { wineArch: 'arm64' },
          CustomFex: { wineArch: 'arm64' },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-probe-6c',
        title: 'Probe 6C Game',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Probe6C'),
            executablePath: path.join(tmpRoot, 'Games/Probe6C/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Probe 6C Game',
        installPath: path.join(tmpRoot, 'Games/Probe6C'),
        executablePath: path.join(tmpRoot, 'Games/Probe6C/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({ hostArch: 'arm64', installedRunners: ['crossover', 'crossover_preview_arm64'] })
      );
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined as any);

      for (const cacheMode of ['warm', 'cold'] as const) {
        for (const orphanBottle of ['CustomMissing', 'OneLauncher-arm64', 'CustomFex']) {
          vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(
            cacheMode === 'warm' ? [crossoverLayer, arm64Layer] : []
          );
          vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
            crossoverLayer,
            arm64Layer,
          ]);
          vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            wineBottleName: orphanBottle,
          } as any);
          saveSpy.mockClear();

          let latestForm: ReturnType<typeof useGameLaunchConfigForm> | null = null;
          const FormHarness: React.FC = () => {
            latestForm = useGameLaunchConfigForm({
              game,
              initialPlatformId: 'steam',
              isOpen: true,
              onClose: vi.fn(),
            });
            return React.createElement('div');
          };
          const fRenderer = createDomain12DeepRenderer(FormHarness, {});
          fRenderer.render();
          await Promise.resolve();
          await Promise.resolve();
          fRenderer.render();

          expect(latestForm!.compatibilityLayer).toBe('crossover');
          expect(latestForm!.wineBottleName).toBe('');
          expect(latestForm!.hasUnsavedChanges).toBe(false);
          fRenderer.unmount();

          const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
            isOpen: true,
            game,
            initialPlatformId: 'steam',
            onClose: vi.fn(),
          });
          let mTree = modal.render();
          await Promise.resolve();
          await Promise.resolve();
          mTree = modal.render();

          const bottleControl = findElements(
            mTree,
            (el) => el.props?.id === 'compat-target-bottle-control'
          )[0];
          const bottleOpts = findElements(bottleControl, (el) => el.type === 'option').map(
            (o) => o.props?.value
          );
          expect(bottleControl.type).toBe('select');
          expect(bottleOpts).toEqual(['', 'OneLauncher']);
          expect(bottleControl.props.value).toBe('');
          expect(findByTestId(mTree, 'compat-bottle-arch-mismatch-warning')).toBeUndefined();

          const saveBtn = findElements(
            mTree,
            (el) => el.type === 'button' && getTextContent(el).includes('Save Configuration')
          )[0];
          await saveBtn.props.onClick();
          expect(saveSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              compatibilityLayer: 'crossover',
              wineBottleName: undefined,
            }),
            'steam'
          );
          modal.unmount();
        }
      }

      // Preserve in-list mismatch warning when OneLauncher IS in availableBottles under crossover_preview_arm64
      const sharedArm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          'OneLauncher-arm64': { wineArch: 'arm64' },
        },
      });
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        sharedArm64Layer,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        crossoverLayer,
        sharedArm64Layer,
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher',
      } as any);

      const warnModal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let wTree = warnModal.render();
      await Promise.resolve();
      wTree = warnModal.render();
      expect(
        findElements(wTree, (el) => el.props?.id === 'compat-target-bottle-control')[0].props.value
      ).toBe('OneLauncher');
      expect(findByTestId(wTree, 'compat-bottle-arch-mismatch-warning')).toBeDefined();
      warnModal.unmount();

      // Free-text <input> (availableBottles: []) preserves CustomFex and surfaces cross-layer arch mismatch warning under crossover
      const emptyCrossoverLayer = makeLayer('crossover', tmpRoot, { availableBottles: [] });
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        emptyCrossoverLayer,
        arm64Layer,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        emptyCrossoverLayer,
        arm64Layer,
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover',
        wineBottleName: 'CustomFex',
      } as any);

      const freeTextModal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let ftTree = freeTextModal.render();
      await Promise.resolve();
      ftTree = freeTextModal.render();

      const customInput = findElements(
        ftTree,
        (el) => el.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(customInput.type).toBe('input');
      expect(customInput.props.value).toBe('CustomFex');
      expect(findByTestId(ftTree, 'compat-bottle-arch-mismatch-warning')).toBeDefined();
      freeTextModal.unmount();
    });
  });

  describe('Iteration 6 Remediation Regressions (Gate 5 Findings A, B & C)', () => {
    it('Finding A: SystemSetupWizardModal preserves user runner and bottle selections made while cold probeHealth is in flight', async () => {
      const intelBottleOnly = [
        {
          name: 'OneLauncher',
          path: '/Applications/CrossOver/Bottles/OneLauncher',
          runnerType: 'crossover' as const,
          wineArch: 'win64' as const,
          bottleArch: 'win64' as const,
          isValid: true,
          hasSteam: true,
          hasGogGalaxy: false,
          hasEpicLauncher: false,
          isSandboxed: false,
        },
      ];
      const arm64Snap = makeSnapshot({
        hostArch: 'arm64',
        installedRunners: ['crossover', 'crossover_preview_arm64'],
        availableBottles: intelBottleOnly,
      });
      const probedArm64Snap = makeSnapshot({
        hostArch: 'arm64',
        installedRunners: ['crossover', 'crossover_preview_arm64'],
        availableBottles: intelBottleOnly,
      });

      let resolveProbe!: (snap: EnvironmentHealthSnapshot) => void;
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(arm64Snap);
      vi.spyOn(environmentSetupService, 'getWizardState').mockReturnValue({
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
      });
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue({
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        preferredRunnerType: 'crossover',
        preferredBottleName: 'OneLauncher',
        configuredComponents: [],
      });
      vi.spyOn(environmentSetupService, 'probeHealth').mockImplementation(
        () =>
          new Promise<EnvironmentHealthSnapshot>((resolve) => {
            resolveProbe = resolve;
          })
      );

      const wizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      let tree = wizard.render();

      const arm64Btn = findByTestId(tree, 'setup-runner-crossover-preview-arm64');
      expect(arm64Btn).toBeDefined();
      arm64Btn!.props.onClick();
      tree = wizard.render();

      expect(findByTestId(tree, 'setup-runner-crossover-preview-arm64')!.props['aria-checked']).toBe(
        true
      );
      const bottleInputBefore = findElements(
        tree,
        (el) => el.type === 'input' && el.props?.['data-testid'] === 'setup-bottle-name-input'
      )[0];
      expect(bottleInputBefore.props.value).toBe('OneLauncher-arm64');

      resolveProbe(probedArm64Snap);
      await Promise.resolve();
      await Promise.resolve();
      tree = wizard.render();

      expect(findByTestId(tree, 'setup-runner-crossover-preview-arm64')!.props['aria-checked']).toBe(
        true
      );
      const bottleInputAfter = findElements(
        tree,
        (el) => el.type === 'input' && el.props?.['data-testid'] === 'setup-bottle-name-input'
      )[0];
      expect(bottleInputAfter.props.value).toBe('OneLauncher-arm64');

      // Custom bottle name edit before probeHealth resolves also survives probe resolution
      wizard.unmount();
      let resolveProbe2!: (snap: EnvironmentHealthSnapshot) => void;
      vi.spyOn(environmentSetupService, 'probeHealth').mockImplementation(
        () =>
          new Promise<EnvironmentHealthSnapshot>((resolve) => {
            resolveProbe2 = resolve;
          })
      );
      const wizard2 = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      let tree2 = wizard2.render();
      findByTestId(tree2, 'setup-runner-crossover-preview-arm64')!.props.onClick();
      tree2 = wizard2.render();
      findElements(
        tree2,
        (el) => el.type === 'input' && el.props?.['data-testid'] === 'setup-bottle-name-input'
      )[0].props.onChange({ target: { value: 'MyCustomFexBottle' } });
      tree2 = wizard2.render();

      resolveProbe2(probedArm64Snap);
      await Promise.resolve();
      await Promise.resolve();
      tree2 = wizard2.render();

      expect(findByTestId(tree2, 'setup-runner-crossover-preview-arm64')!.props['aria-checked']).toBe(
        true
      );
      expect(
        findElements(
          tree2,
          (el) => el.type === 'input' && el.props?.['data-testid'] === 'setup-bottle-name-input'
        )[0].props.value
      ).toBe('MyCustomFexBottle');
      wizard2.unmount();
    });

    it('Finding B (Probe 4A/7B & Probe 7A): cold-cache pre-detect runner switch and pre-detect bottle input sanitize orphan <select> values once detectCompatibilityLayers resolves while keeping free-text custom bottles', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const previewLayer = makeLayer('crossover_preview', tmpRoot, {
        availableBottles: ['OneLauncher', 'PreviewOnlyBottle'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          PreviewOnlyBottle: { wineArch: 'win64' },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-finding-b1',
        title: 'Finding B Cold Race',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/FindingB1'),
            executablePath: path.join(tmpRoot, 'Games/FindingB1/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Finding B Cold Race',
        installPath: path.join(tmpRoot, 'Games/FindingB1'),
        executablePath: path.join(tmpRoot, 'Games/FindingB1/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({ hostArch: 'arm64', installedRunners: ['crossover', 'crossover_preview'] })
      );
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined as any);

      // Probe 4A / 7B: saved crossover_preview + PreviewOnlyBottle -> user switches to crossover before detect resolves
      let resolveDetect1!: (layers: CompatibilityLayerInfo[]) => void;
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockImplementation(
        () =>
          new Promise<CompatibilityLayerInfo[]>((resolve) => {
            resolveDetect1 = resolve;
          })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'PreviewOnlyBottle',
      } as any);

      const modal1 = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let tree1 = modal1.render();
      findByTestId(tree1, 'compat-runner-select')!.props.onChange({
        target: { value: 'crossover' },
      });
      tree1 = modal1.render();

      resolveDetect1([crossoverLayer, previewLayer]);
      await Promise.resolve();
      await Promise.resolve();
      tree1 = modal1.render();

      const ctrl1 = findElements(tree1, (el) => el.props?.id === 'compat-target-bottle-control')[0];
      expect(ctrl1.type).toBe('select');
      expect(findElements(ctrl1, (el) => el.type === 'option').map((o) => o.props?.value)).toEqual([
        '',
        'OneLauncher',
      ]);
      expect(ctrl1.props.value).toBe('');

      const saveBtn1 = findElements(
        tree1,
        (el) => el.type === 'button' && getTextContent(el).includes('Save Configuration')
      )[0];
      await saveBtn1.props.onClick();
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          compatibilityLayer: 'crossover',
          wineBottleName: undefined,
        }),
        'steam'
      );
      modal1.unmount();

      // Probe 7A: user types 'UserTypedBeforeDetect' before detect resolves with availableBottles: ['OneLauncher']
      saveSpy.mockClear();
      let resolveDetect2!: (layers: CompatibilityLayerInfo[]) => void;
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockImplementation(
        () =>
          new Promise<CompatibilityLayerInfo[]>((resolve) => {
            resolveDetect2 = resolve;
          })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover',
      } as any);

      const modal2 = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let tree2 = modal2.render();
      const input2 = findElements(tree2, (el) => el.props?.id === 'compat-target-bottle-control')[0];
      expect(input2.type).toBe('input');
      input2.props.onChange({ target: { value: 'UserTypedBeforeDetect' } });
      tree2 = modal2.render();

      resolveDetect2([crossoverLayer]);
      await Promise.resolve();
      await Promise.resolve();
      tree2 = modal2.render();

      const ctrl2 = findElements(tree2, (el) => el.props?.id === 'compat-target-bottle-control')[0];
      expect(ctrl2.type).toBe('select');
      expect(ctrl2.props.value).toBe('');
      modal2.unmount();

      // Probe 6 preservation: editing bottle when targetLayer.availableBottles is [] preserves 'MyCustomBottle'
      saveSpy.mockClear();
      let resolveDetect3!: (layers: CompatibilityLayerInfo[]) => void;
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockImplementation(
        () =>
          new Promise<CompatibilityLayerInfo[]>((resolve) => {
            resolveDetect3 = resolve;
          })
      );
      const modal3 = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let tree3 = modal3.render();
      findElements(tree3, (el) => el.props?.id === 'compat-target-bottle-control')[0].props.onChange({
        target: { value: 'MyCustomBottle' },
      });
      tree3 = modal3.render();

      resolveDetect3([makeLayer('crossover', tmpRoot, { availableBottles: [] })]);
      await Promise.resolve();
      await Promise.resolve();
      tree3 = modal3.render();

      const ctrl3 = findElements(tree3, (el) => el.props?.id === 'compat-target-bottle-control')[0];
      expect(ctrl3.type).toBe('input');
      expect(ctrl3.props.value).toBe('MyCustomBottle');
      modal3.unmount();
    });

    it('Finding B (Probe 9 / 4B & Probe 4C): storefront switch before detect resolves sanitizes destination orphan bottle (while preserving valid host layers) and cold-cache handleResetDefaults updates to detected preferred layer', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const previewLayer = makeLayer('crossover_preview', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher-arm64', 'CustomFex'],
        bottleDetails: {
          'OneLauncher-arm64': { wineArch: 'arm64' },
          CustomFex: { wineArch: 'arm64' },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-finding-b2',
        title: 'Finding B Switch & Reset',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/FindingB2Steam'),
            executablePath: path.join(tmpRoot, 'Games/FindingB2Steam/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
          {
            platformId: 'epic',
            platformGameId: 'epic-b2',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/FindingB2Epic'),
            executablePath: path.join(tmpRoot, 'Games/FindingB2Epic/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Finding B Switch & Reset',
        installPath: path.join(tmpRoot, 'Games/FindingB2Steam'),
        executablePath: path.join(tmpRoot, 'Games/FindingB2Steam/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({
          hostArch: 'arm64',
          installedRunners: ['crossover', 'crossover_preview', 'crossover_preview_arm64'],
        })
      );
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined as any);
      vi.spyOn(launcherService, 'resetLaunchConfig').mockResolvedValue(undefined as any);

      // Probe 9 / 4B: steam has orphan 'OneLauncher-arm64', epic has orphan 'CustomFex' under crossover
      let resolveSwitchDetect!: (layers: CompatibilityLayerInfo[]) => void;
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockImplementation(
        () =>
          new Promise<CompatibilityLayerInfo[]>((resolve) => {
            resolveSwitchDetect = resolve;
          })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockImplementation((_gId, platId) =>
        platId === 'epic'
          ? ({
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
              wineBottleName: 'CustomFex',
            } as any)
          : ({
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
              wineBottleName: 'OneLauncher-arm64',
            } as any)
      );

      const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let tree = modal.render();
      const epicTab = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Epic')
      )[0];
      epicTab.props.onClick();
      tree = modal.render();

      resolveSwitchDetect([crossoverLayer, arm64Layer]);
      await Promise.resolve();
      await Promise.resolve();
      tree = modal.render();

      const epicBottleCtrl = findElements(
        tree,
        (el) => el.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(epicBottleCtrl.type).toBe('select');
      expect(findElements(epicBottleCtrl, (el) => el.type === 'option').map((o) => o.props?.value)).toEqual([
        '',
        'OneLauncher',
      ]);
      expect(epicBottleCtrl.props.value).toBe('');

      const saveBtn = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Save Configuration')
      )[0];
      await saveBtn.props.onClick();
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          preferredPlatformId: 'epic',
          compatibilityLayer: 'crossover',
          wineBottleName: undefined,
          platformConfigs: expect.objectContaining({
            steam: expect.objectContaining({ wineBottleName: undefined }),
            epic: expect.objectContaining({ wineBottleName: undefined }),
          }),
        }),
        'epic'
      );
      modal.unmount();

      // Probe 5C preservation: switching steam -> epic before detect resolves preserves valid host-supported 'crossover_preview'
      let resolveSwitchDetect5C!: (layers: CompatibilityLayerInfo[]) => void;
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockImplementation(
        () =>
          new Promise<CompatibilityLayerInfo[]>((resolve) => {
            resolveSwitchDetect5C = resolve;
          })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockImplementation((_gId, platId) =>
        platId === 'epic'
          ? ({
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover_preview',
            } as any)
          : undefined
      );
      const modal5C = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let tree5C = modal5C.render();
      findElements(
        tree5C,
        (el) => el.type === 'button' && getTextContent(el).includes('Epic')
      )[0].props.onClick();
      tree5C = modal5C.render();
      resolveSwitchDetect5C([crossoverLayer, previewLayer]);
      await Promise.resolve();
      await Promise.resolve();
      tree5C = modal5C.render();
      expect(findByTestId(tree5C, 'compat-runner-select')!.props.value).toBe('crossover_preview');
      modal5C.unmount();

      // Probe 4C: cold-cache handleResetDefaults updates compatibilityLayer when detectCompatibilityLayers resolves
      let resolveResetDetect!: (layers: CompatibilityLayerInfo[]) => void;
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockImplementation(
        () =>
          new Promise<CompatibilityLayerInfo[]>((resolve) => {
            resolveResetDetect = resolve;
          })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher-arm64',
      } as any);

      let latestForm: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const ResetHarness: React.FC = () => {
        latestForm = useGameLaunchConfigForm({
          game,
          initialPlatformId: 'steam',
          isOpen: true,
          onClose: vi.fn(),
        });
        return React.createElement('div');
      };
      const resetRenderer = createDomain12DeepRenderer(ResetHarness, {});
      resetRenderer.render();

      await latestForm!.handleResetDefaults();
      resetRenderer.render();
      expect(latestForm!.compatibilityLayer).toBe('crossover');

      resolveResetDetect([previewLayer, crossoverLayer]);
      await Promise.resolve();
      await Promise.resolve();
      resetRenderer.render();

      expect(latestForm!.compatibilityLayer).toBe('crossover_preview');
      expect(latestForm!.wineBottleName).toBe('');
      expect(latestForm!.hasUnsavedChanges).toBe(false);
      resetRenderer.unmount();
    });

    it('Finding C: standalone CompatibilityLayerSection on x64 recomputes DLSS eligibility, reason, and D3DMetal version selector from downgraded effectiveActiveLayer', () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
        supportsMetalFxDlssD3dMetal: false,
        supportsMetalFxDlssDxmt: false,
        availableD3DMetalVersions: undefined,
      });
      const arm64Layer = makeLayer('crossover_preview_arm64', tmpRoot, {
        availableBottles: ['OneLauncher-arm64'],
        bottleDetails: { 'OneLauncher-arm64': { wineArch: 'arm64' } },
        supportsMetalFxDlssD3dMetal: true,
        supportsMetalFxDlssDxmt: true,
        availableD3DMetalVersions: [
          { id: '4', label: 'D3DMetal 4.0b3', version: '4.0b3', isDefault: true },
          { id: '3', label: 'D3DMetal 3.0', version: '3.0', isDefault: false },
        ],
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-finding-c',
        title: 'Finding C Standalone x64',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/FindingC'),
            executablePath: path.join(tmpRoot, 'Games/FindingC/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });
      const policy = buildEffectiveLaunchModePreview({
        game,
        preferredPlatformId: 'steam',
        effPlatform: undefined,
        hostPlatform: 'darwin',
        hostArch: 'x64',
        draftConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
        },
        layers: [crossoverLayer, arm64Layer],
        globalStorefrontLifecycle: DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.storefrontClientLifecycle,
      });

      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      const arm64Descriptor = COMPATIBILITY_RUNNER_DESCRIPTORS.find(
        (d) => d.type === 'crossover_preview_arm64'
      )!;
      const section = createDomain12DeepRenderer(CompatibilityLayerSection, {
        isWindowsHost: false,
        detectedLayers: [crossoverLayer, arm64Layer],
        activeLayer: arm64Layer,
        availableBottles: ['OneLauncher-arm64'],
        runnerUpdates: {},
        isCheckingUpdates: false,
        compatibilityLayer: 'crossover_preview_arm64',
        selectedRunnerDescriptor: arm64Descriptor,
        activeSecondaryBuildText: '',
        wineBottleName: 'OneLauncher-arm64',
        winePrefixPath: '',
        crossoverGraphicsBackend: 'd3dmetal',
        crossoverD3DMetalVersion: 'auto',
        showD3DMetalVersionSelector: true,
        primaryD3DVer: '4.0b3',
        fallbackD3DVer: '3.0',
        isDlssSupportedBackend: true,
        dlssUnavailableReason: 'Stale arm64 reason should not be shown',
        isDxvkHudSupported: false,
        crossoverHighResolutionMode: undefined,
        crossoverDlss: true,
        preferredMaxFrameRate: undefined,
        metalfxSpatialUpscaleFactor: undefined,
        displayScalingMode: 'default',
        displayAspectRatio: 'default',
        virtualDesktopResolution: 'auto',
        emulateModeset: undefined,
        forceLargeAddressAware: undefined,
        wineMsync: true,
        wineEsync: false,
        metalHud: false,
        dxvkHud: false,
        activeDisplayMethod: 'compatibility_layer',
        preview: policy,
        isInstallingRunner: false,
        isUpdatingRunner: false,
        isRescanningRunners: false,
        runnerActionFeedback: null,
        runnerUpdateFeedback: null,
        onSelectCompatibilityLayer: vi.fn(),
        onChangeWineBottleName: vi.fn(),
        onChangeWinePrefixPath: vi.fn(),
        onBrowseWinePrefix: vi.fn(),
        onOpenBottleFolder: vi.fn(),
        onRescanLayers: vi.fn(),
        onChangeCrossoverGraphicsBackend: vi.fn(),
        onChangeCrossoverD3DMetalVersion: vi.fn(),
        onChangeCrossoverHighResolutionMode: vi.fn(),
        onToggleCrossoverDlss: vi.fn(),
        onChangePreferredMaxFrameRate: vi.fn(),
        onChangeMetalfxSpatialUpscaleFactor: vi.fn(),
        onChangeDisplayScalingMode: vi.fn(),
        onChangeDisplayAspectRatio: vi.fn(),
        onChangeVirtualDesktopResolution: vi.fn(),
        onChangeEmulateModeset: vi.fn(),
        onToggleForceLargeAddressAware: vi.fn(),
        onToggleWineMsync: vi.fn(),
        onToggleWineEsync: vi.fn(),
        onToggleMetalHud: vi.fn(),
        onToggleDxvkHud: vi.fn(),
        onInstallRunnerViaBrew: vi.fn(),
        onInstallRunnerFromArchive: vi.fn(),
        onCheckRunnerUpdates: vi.fn(),
        onUpdateRunner: vi.fn(),
        onSwitchToStableCrossOver: vi.fn(),
        onDownloadRunner: vi.fn(),
        onCancelRunnerOperation: vi.fn(),
      });
      const tree = section.render();

      const dlssSwitch = findByTestId(tree, 'toggle-crossover-dlss')!;
      expect(dlssSwitch.props.disabled).toBe(true);
      expect(dlssSwitch.props['aria-checked']).toBe(false);

      const dlssHintText = getTextContent(findByTestId(tree, 'crossover-dlss-hint')!);
      expect(dlssHintText).not.toContain('Stale arm64 reason should not be shown');
      expect(dlssHintText).toContain('D3DMetal MetalFX DLSS requires macOS Tahoe 26+');

      expect(findByTestId(tree, 'crossover-d3dmetal-version-section')).toBeUndefined();
      section.unmount();
    });
  });

  describe('Iteration 7 Remediation Regressions (Challenger 2 R6 Defects 1, 2 & 3)', () => {
    it('Defect 1: SystemSetupWizardModal reopen with persisted non-existent custom bottle preserves create_dedicated mode and selects bottle_default & bottle_steam even when another compatible bottle exists', async () => {
      const arm64BottleSnapshot = makeSnapshot({
        hostArch: 'arm64',
        installedRunners: ['crossover', 'crossover_preview_arm64'],
        availableBottles: [
          {
            name: 'OneLauncher-arm64',
            path: '/Applications/CrossOver/BottlesArm64/OneLauncher-arm64',
            runnerType: 'crossover_preview_arm64',
            wineArch: 'arm64',
            bottleArch: 'arm64',
            hasSteam: true,
            hasGogGalaxy: false,
            hasEpicLauncher: false,
            isSandboxed: false,
          },
        ],
      });
      arm64BottleSnapshot.components.bottle_default = {
        ...arm64BottleSnapshot.components.bottle_default,
        status: 'ready',
      };
      arm64BottleSnapshot.components.bottle_steam = {
        ...arm64BottleSnapshot.components.bottle_steam,
        status: 'ready',
      };

      const persistedWizardState = {
        schemaVersion: 1 as const,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        preferredRunnerType: 'crossover_preview_arm64' as const,
        preferredBottleName: 'MyCustomFexBottle',
        configuredComponents: [],
      };

      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(arm64BottleSnapshot);
      vi.spyOn(environmentSetupService, 'getWizardState').mockReturnValue(persistedWizardState);
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue(persistedWizardState);
      vi.spyOn(environmentSetupService, 'probeHealth').mockResolvedValue(arm64BottleSnapshot);

      const wizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      wizard.render();

      // Close and reopen the modal (`isOpen: false -> true`)
      wizard.render({ isOpen: false });
      wizard.render({ isOpen: true });

      await Promise.resolve();
      await Promise.resolve();
      let tree = wizard.render();

      expect(findByTestId(tree, 'setup-runner-crossover-preview-arm64')!.props['aria-checked']).toBe(
        true
      );
      expect(findByTestId(tree, 'setup-bottle-mode-create')!.props['aria-checked']).toBe(true);
      expect(findByTestId(tree, 'setup-bottle-mode-reuse')!.props['aria-checked']).toBe(false);
      expect(
        findElements(
          tree,
          (el) => el.type === 'input' && el.props?.['data-testid'] === 'setup-bottle-name-input'
        )[0].props.value
      ).toBe('MyCustomFexBottle');

      // Advance to Summary step (compatibility -> clients -> summary) and verify both tasks
      findByTestId(tree, 'setup-next-step-btn')!.props.onClick();
      tree = wizard.render();
      findByTestId(tree, 'setup-next-step-btn')!.props.onClick();
      tree = wizard.render();

      const summaryText = getTextContent(findByTestId(tree, 'setup-step-summary'));
      expect(summaryText).toContain('Create "MyCustomFexBottle" bottle');
      expect(summaryText).toContain('Install Steam (Windows)');
      wizard.unmount();

      // Negative/control check: when persisted bottle DOES exist & bottle_steam is 'ready', reuse_existing is selected and Install Steam (Windows) is NOT added
      const existingBottleState = {
        ...persistedWizardState,
        preferredBottleName: 'OneLauncher-arm64',
      };
      vi.spyOn(environmentSetupService, 'getWizardState').mockReturnValue(existingBottleState);
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue(existingBottleState);

      const reuseWizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      await Promise.resolve();
      await Promise.resolve();
      let reuseTree = reuseWizard.render();
      expect(findByTestId(reuseTree, 'setup-bottle-mode-reuse')!.props['aria-checked']).toBe(true);
      expect(findByTestId(reuseTree, 'setup-bottle-mode-create')!.props['aria-checked']).toBe(false);
      findByTestId(reuseTree, 'setup-next-step-btn')!.props.onClick();
      reuseTree = reuseWizard.render();
      findByTestId(reuseTree, 'setup-next-step-btn')!.props.onClick();
      reuseTree = reuseWizard.render();
      const reuseSummary = getTextContent(findByTestId(reuseTree, 'setup-step-summary'));
      expect(reuseSummary).not.toContain('Install Steam (Windows)');
      reuseWizard.unmount();
    });

    it('Defect 2: handleSwitchToStableCrossOver and handleUpdateRunner (stableSurpassesPreview) clear orphan wineBottleName not in crossover.availableBottles', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const previewLayer = makeLayer('crossover_preview', tmpRoot, {
        availableBottles: ['OneLauncher', 'PreviewOnlyBottle'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          PreviewOnlyBottle: { wineArch: 'win64' },
        },
      });
      const game = makeCanonicalGameFixture({
        id: 'steam-defect-2',
        title: 'Defect 2 Orphan Bottle',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Defect2'),
            executablePath: path.join(tmpRoot, 'Games/Defect2/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        previewLayer,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        crossoverLayer,
        previewLayer,
      ]);
      const stableSurpassesInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        latestVersion: '27.1.0',
        updateAvailable: false,
        canAutoUpdate: false,
        stableSurpassesPreview: true,
        checkedAt: '2026-11-18T00:00:00.000Z',
      };
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
        crossover_preview: stableSurpassesInfo,
      });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({
        crossover_preview: stableSurpassesInfo,
      });
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Defect 2 Orphan Bottle',
        installPath: path.join(tmpRoot, 'Games/Defect2'),
        executablePath: path.join(tmpRoot, 'Games/Defect2/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({ hostArch: 'arm64', installedRunners: ['crossover', 'crossover_preview'] })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'PreviewOnlyBottle',
      } as any);
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined as any);
      const updateSpy = vi
        .spyOn(launcherService, 'updateCompatibilityLayer')
        .mockResolvedValue({
          success: true,
          updated: true,
          runnerType: 'crossover',
          message: 'Switched to CrossOver Stable.',
          detectedLayers: [crossoverLayer, previewLayer],
        });

      // Part A: handleSwitchToStableCrossOver via useGameLaunchConfigForm + CompatibilityLayerSection
      let formA: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const SwitchHarness: React.FC = () => {
        formA = useGameLaunchConfigForm({
          isOpen: true,
          game,
          initialPlatformId: 'steam',
          onClose: vi.fn(),
        });
        return React.createElement(CompatibilityLayerSection, {
          isWindowsHost: formA.isWindowsHost,
          detectedLayers: formA.detectedLayers,
          activeLayer: formA.activeLayer,
          availableBottles: formA.availableBottles,
          runnerUpdates: formA.runnerUpdates,
          isCheckingUpdates: formA.isCheckingUpdates,
          compatibilityLayer: formA.compatibilityLayer,
          selectedRunnerDescriptor: formA.selectedRunnerDescriptor,
          activeSecondaryBuildText: formA.activeSecondaryBuildText,
          wineBottleName: formA.wineBottleName,
          winePrefixPath: formA.winePrefixPath,
          crossoverGraphicsBackend: formA.crossoverGraphicsBackend,
          crossoverD3DMetalVersion: formA.crossoverD3DMetalVersion,
          showD3DMetalVersionSelector: formA.showD3DMetalVersionSelector,
          primaryD3DVer: formA.primaryD3DVer,
          fallbackD3DVer: formA.fallbackD3DVer,
          isDlssSupportedBackend: formA.isDlssSupportedBackend,
          dlssUnavailableReason: formA.dlssUnavailableReason,
          isDxvkHudSupported: formA.isDxvkHudSupported,
          crossoverHighResolutionMode: formA.crossoverHighResolutionMode,
          crossoverDlss: formA.crossoverDlss,
          preferredMaxFrameRate: formA.preferredMaxFrameRate,
          metalfxSpatialUpscaleFactor: formA.metalfxSpatialUpscaleFactor,
          displayScalingMode: formA.displayScalingMode,
          displayAspectRatio: formA.displayAspectRatio,
          virtualDesktopResolution: formA.virtualDesktopResolution,
          emulateModeset: formA.emulateModeset,
          forceLargeAddressAware: formA.forceLargeAddressAware,
          wineMsync: formA.wineMsync,
          wineEsync: formA.wineEsync,
          metalHud: formA.metalHud,
          dxvkHud: formA.dxvkHud,
          activeDisplayMethod: formA.activeDisplayMethod,
          preview: formA.preview,
          isInstallingRunner: formA.isInstallingRunner,
          isUpdatingRunner: formA.isUpdatingRunner,
          isRescanningRunners: formA.isRescanningRunners,
          runnerActionFeedback: formA.runnerActionFeedback,
          runnerUpdateFeedback: formA.runnerUpdateFeedback,
          onSelectCompatibilityLayer: formA.handleSelectCompatibilityLayer,
          onChangeWineBottleName: formA.setWineBottleName,
          onChangeWinePrefixPath: formA.setWinePrefixPath,
          onBrowseWinePrefix: formA.handleBrowseWinePrefix,
          onOpenBottleFolder: formA.handleOpenBottleFolder,
          onRescanLayers: formA.handleRescanLayers,
          onChangeCrossoverGraphicsBackend: formA.setCrossoverGraphicsBackend,
          onChangeCrossoverD3DMetalVersion: formA.setCrossoverD3DMetalVersion,
          onChangeCrossoverHighResolutionMode: formA.setCrossoverHighResolutionMode,
          onToggleCrossoverDlss: formA.handleToggleCrossoverDlss,
          onChangePreferredMaxFrameRate: formA.setPreferredMaxFrameRate,
          onChangeMetalfxSpatialUpscaleFactor: formA.setMetalfxSpatialUpscaleFactor,
          onChangeDisplayScalingMode: formA.setDisplayScalingMode,
          onChangeDisplayAspectRatio: formA.setDisplayAspectRatio,
          onChangeVirtualDesktopResolution: formA.setVirtualDesktopResolution,
          onChangeEmulateModeset: formA.setEmulateModeset,
          onToggleForceLargeAddressAware: formA.handleToggleForceLargeAddressAware,
          onToggleWineMsync: formA.handleToggleWineMsync,
          onToggleWineEsync: formA.handleToggleWineEsync,
          onToggleMetalHud: formA.handleToggleMetalHud,
          onToggleDxvkHud: formA.handleToggleDxvkHud,
          onInstallRunnerViaBrew: formA.handleInstallRunnerViaBrew,
          onInstallRunnerFromArchive: formA.handleInstallRunnerFromArchive,
          onCheckRunnerUpdates: formA.handleCheckRunnerUpdates,
          onUpdateRunner: formA.handleUpdateRunner,
          onSwitchToStableCrossOver: formA.handleSwitchToStableCrossOver,
          onDownloadRunner: formA.handleDownloadRunner,
          onCancelRunnerOperation: formA.handleCancelRunnerOperation,
        });
      };
      const modal = createDomain12DeepRenderer(SwitchHarness, {});
      modal.render();
      await Promise.resolve();
      await Promise.resolve();
      let tree = modal.render();

      expect(findByTestId(tree, 'compat-runner-select')!.props.value).toBe('crossover_preview');
      expect(
        findElements(tree, (el) => el.props?.id === 'compat-target-bottle-control')[0].props.value
      ).toBe('PreviewOnlyBottle');

      await formA!.handleSwitchToStableCrossOver();
      await Promise.resolve();
      await Promise.resolve();
      tree = modal.render();

      expect(updateSpy).toHaveBeenCalledWith('crossover_preview', {
        switchToStableCrossOver: true,
      });
      expect(findByTestId(tree, 'compat-runner-select')!.props.value).toBe('crossover');
      const bottleCtrlAfterSwitch = findElements(
        tree,
        (el) => el.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(bottleCtrlAfterSwitch.type).toBe('select');
      expect(bottleCtrlAfterSwitch.props.value).toBe('');

      await formA!.handleSave();
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          compatibilityLayer: 'crossover',
          wineBottleName: undefined,
        }),
        'steam'
      );
      modal.unmount();

      // Part B: handleUpdateRunner when stableSurpassesPreview === true && !canAutoUpdate
      updateSpy.mockClear();
      let formRef: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const Harness: React.FC = () => {
        formRef = useGameLaunchConfigForm({
          isOpen: true,
          game,
          initialPlatformId: 'steam',
          onClose: vi.fn(),
        });
        return React.createElement('div');
      };
      const harness = createDomain12DeepRenderer(Harness, {});
      harness.render();
      await Promise.resolve();
      await Promise.resolve();
      harness.render();

      expect(formRef!.compatibilityLayer).toBe('crossover_preview');
      expect(formRef!.wineBottleName).toBe('PreviewOnlyBottle');

      await formRef!.handleUpdateRunner();
      await Promise.resolve();
      harness.render();

      expect(updateSpy).toHaveBeenCalledWith('crossover_preview', {
        switchToStableCrossOver: true,
      });
      expect(formRef!.compatibilityLayer).toBe('crossover');
      expect(formRef!.wineBottleName).toBe('');
      harness.unmount();
    });

    it('Defect 3: switching storefront tabs while handleSwitchToStableCrossOver is pending does not clobber the active tab and updates the originating platform draft cleanly', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const previewLayer = makeLayer('crossover_preview', tmpRoot, {
        availableBottles: ['OneLauncher', 'PreviewOnlyBottle'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          PreviewOnlyBottle: { wineArch: 'win64' },
        },
      });
      const wineLayer = makeLayer('wine', tmpRoot, {
        availableBottles: [],
      });
      const game = makeCanonicalGameFixture({
        id: 'multi-defect-3',
        title: 'Defect 3 Tab Switch',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Defect3Steam'),
            executablePath: path.join(tmpRoot, 'Games/Defect3Steam/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
          {
            platformId: 'epic',
            platformGameId: 'epic-d3',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Defect3Epic'),
            executablePath: path.join(tmpRoot, 'Games/Defect3Epic/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        previewLayer,
        wineLayer,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        crossoverLayer,
        previewLayer,
        wineLayer,
      ]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Defect 3 Tab Switch',
        installPath: path.join(tmpRoot, 'Games/Defect3Steam'),
        executablePath: path.join(tmpRoot, 'Games/Defect3Steam/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({
          hostArch: 'arm64',
          installedRunners: ['crossover', 'crossover_preview', 'wine'],
        })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockImplementation((_gId, platId) =>
        platId === 'epic'
          ? ({
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'wine',
            } as any)
          : ({
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover_preview',
              wineBottleName: 'PreviewOnlyBottle',
            } as any)
      );

      let resolveSwitch!: (res: any) => void;
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSwitch = resolve;
          })
      );

      let formRef: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const Harness: React.FC = () => {
        formRef = useGameLaunchConfigForm({
          isOpen: true,
          game,
          initialPlatformId: 'steam',
          onClose: vi.fn(),
        });
        return React.createElement('div');
      };
      const harness = createDomain12DeepRenderer(Harness, {});
      harness.render();
      await Promise.resolve();
      await Promise.resolve();
      harness.render();

      expect(formRef!.preferredPlatformId).toBe('steam');
      expect(formRef!.compatibilityLayer).toBe('crossover_preview');

      // Start switch to CrossOver Stable on steam, then immediately switch tab to epic before it resolves
      const switchPromise = formRef!.handleSwitchToStableCrossOver();
      formRef!.handleSelectStorefront('epic');
      harness.render();
      expect(formRef!.preferredPlatformId).toBe('epic');
      expect(formRef!.compatibilityLayer).toBe('wine');

      resolveSwitch({
        success: true,
        runnerType: 'crossover',
        message: 'Switched to CrossOver Stable.',
        detectedLayers: [crossoverLayer, previewLayer, wineLayer],
      });
      await switchPromise;
      await Promise.resolve();
      harness.render();

      // Active epic tab must remain 'wine'
      expect(formRef!.preferredPlatformId).toBe('epic');
      expect(formRef!.compatibilityLayer).toBe('wine');

      // Switching back to steam must reflect 'crossover' with orphan 'PreviewOnlyBottle' cleared
      formRef!.handleSelectStorefront('steam');
      harness.render();
      expect(formRef!.preferredPlatformId).toBe('steam');
      expect(formRef!.compatibilityLayer).toBe('crossover');
      expect(formRef!.wineBottleName).toBe('');
      harness.unmount();

      // Also verify handleUpdateRunner (stableSurpassesPreview) respects mid-flight tab switch
      const stableUpdateInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        latestVersion: '27.1.0',
        updateAvailable: false,
        canAutoUpdate: false,
        stableSurpassesPreview: true,
        checkedAt: '2026-11-18T00:00:00.000Z',
      };
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
        crossover_preview: stableUpdateInfo,
      });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({
        crossover_preview: stableUpdateInfo,
      });
      let resolveUpdateSwitch!: (res: any) => void;
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveUpdateSwitch = resolve;
          })
      );
      const harness2 = createDomain12DeepRenderer(Harness, {});
      harness2.render();
      await Promise.resolve();
      await Promise.resolve();
      harness2.render();

      const updateSwitchPromise = formRef!.handleUpdateRunner();
      formRef!.handleSelectStorefront('epic');
      harness2.render();
      expect(formRef!.preferredPlatformId).toBe('epic');
      expect(formRef!.compatibilityLayer).toBe('wine');

      resolveUpdateSwitch({
        success: true,
        runnerType: 'crossover',
        message: 'Switched to CrossOver Stable.',
        detectedLayers: [crossoverLayer, previewLayer, wineLayer],
      });
      await updateSwitchPromise;
      await Promise.resolve();
      harness2.render();

      expect(formRef!.preferredPlatformId).toBe('epic');
      expect(formRef!.compatibilityLayer).toBe('wine');
      formRef!.handleSelectStorefront('steam');
      harness2.render();
      expect(formRef!.compatibilityLayer).toBe('crossover');
      expect(formRef!.wineBottleName).toBe('');
      harness2.unmount();
    });
  });

  describe('Iteration 8 Remediation Regressions (Gate 7 Verifier Findings)', () => {
    it('Probe 1C-i: manual compat-runner-select change to wine during in-flight handleSwitchToStableCrossOver or handleUpdateRunner is preserved', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const previewLayer = makeLayer('crossover_preview', tmpRoot, {
        availableBottles: ['OneLauncher', 'PreviewOnlyBottle'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          PreviewOnlyBottle: { wineArch: 'win64' },
        },
      });
      const wineLayer = makeLayer('wine', tmpRoot, { availableBottles: [] });
      const game = makeCanonicalGameFixture({
        id: 'steam-probe-1c-i',
        title: 'Probe 1C-i Manual Runner Edit',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Probe1Ci'),
            executablePath: path.join(tmpRoot, 'Games/Probe1Ci/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      const stableSurpassesInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        latestVersion: '27.1.0',
        updateAvailable: false,
        canAutoUpdate: false,
        stableSurpassesPreview: true,
        checkedAt: '2026-11-18T00:00:00.000Z',
      };

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        previewLayer,
        wineLayer,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        crossoverLayer,
        previewLayer,
        wineLayer,
      ]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
        crossover_preview: stableSurpassesInfo,
      });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({
        crossover_preview: stableSurpassesInfo,
      });
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Probe 1C-i Manual Runner Edit',
        installPath: path.join(tmpRoot, 'Games/Probe1Ci'),
        executablePath: path.join(tmpRoot, 'Games/Probe1Ci/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({
          hostArch: 'arm64',
          installedRunners: ['crossover', 'crossover_preview', 'wine'],
        })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'PreviewOnlyBottle',
      } as any);
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined as any);

      let resolveSwitch!: (res: any) => void;
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSwitch = resolve;
          })
      );

      let formRef: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const Harness: React.FC = () => {
        formRef = useGameLaunchConfigForm({
          isOpen: true,
          game,
          initialPlatformId: 'steam',
          onClose: vi.fn(),
        });
        return React.createElement(CompatibilityLayerSection, {
          isWindowsHost: formRef.isWindowsHost,
          detectedLayers: formRef.detectedLayers,
          activeLayer: formRef.activeLayer,
          availableBottles: formRef.availableBottles,
          runnerUpdates: formRef.runnerUpdates,
          isCheckingUpdates: formRef.isCheckingUpdates,
          compatibilityLayer: formRef.compatibilityLayer,
          selectedRunnerDescriptor: formRef.selectedRunnerDescriptor,
          activeSecondaryBuildText: formRef.activeSecondaryBuildText,
          wineBottleName: formRef.wineBottleName,
          winePrefixPath: formRef.winePrefixPath,
          crossoverGraphicsBackend: formRef.crossoverGraphicsBackend,
          crossoverD3DMetalVersion: formRef.crossoverD3DMetalVersion,
          showD3DMetalVersionSelector: formRef.showD3DMetalVersionSelector,
          primaryD3DVer: formRef.primaryD3DVer,
          fallbackD3DVer: formRef.fallbackD3DVer,
          isDlssSupportedBackend: formRef.isDlssSupportedBackend,
          dlssUnavailableReason: formRef.dlssUnavailableReason,
          isDxvkHudSupported: formRef.isDxvkHudSupported,
          crossoverHighResolutionMode: formRef.crossoverHighResolutionMode,
          crossoverDlss: formRef.crossoverDlss,
          preferredMaxFrameRate: formRef.preferredMaxFrameRate,
          metalfxSpatialUpscaleFactor: formRef.metalfxSpatialUpscaleFactor,
          displayScalingMode: formRef.displayScalingMode,
          displayAspectRatio: formRef.displayAspectRatio,
          virtualDesktopResolution: formRef.virtualDesktopResolution,
          emulateModeset: formRef.emulateModeset,
          forceLargeAddressAware: formRef.forceLargeAddressAware,
          wineMsync: formRef.wineMsync,
          wineEsync: formRef.wineEsync,
          metalHud: formRef.metalHud,
          dxvkHud: formRef.dxvkHud,
          activeDisplayMethod: formRef.activeDisplayMethod,
          preview: formRef.preview,
          isInstallingRunner: formRef.isInstallingRunner,
          isUpdatingRunner: formRef.isUpdatingRunner,
          isRescanningRunners: formRef.isRescanningRunners,
          runnerActionFeedback: formRef.runnerActionFeedback,
          runnerUpdateFeedback: formRef.runnerUpdateFeedback,
          onSelectCompatibilityLayer: formRef.handleSelectCompatibilityLayer,
          onChangeWineBottleName: formRef.setWineBottleName,
          onChangeWinePrefixPath: formRef.setWinePrefixPath,
          onBrowseWinePrefix: formRef.handleBrowseWinePrefix,
          onOpenBottleFolder: formRef.handleOpenBottleFolder,
          onRescanLayers: formRef.handleRescanLayers,
          onChangeCrossoverGraphicsBackend: formRef.setCrossoverGraphicsBackend,
          onChangeCrossoverD3DMetalVersion: formRef.setCrossoverD3DMetalVersion,
          onChangeCrossoverHighResolutionMode: formRef.setCrossoverHighResolutionMode,
          onToggleCrossoverDlss: formRef.handleToggleCrossoverDlss,
          onChangePreferredMaxFrameRate: formRef.setPreferredMaxFrameRate,
          onChangeMetalfxSpatialUpscaleFactor: formRef.setMetalfxSpatialUpscaleFactor,
          onChangeDisplayScalingMode: formRef.setDisplayScalingMode,
          onChangeDisplayAspectRatio: formRef.setDisplayAspectRatio,
          onChangeVirtualDesktopResolution: formRef.setVirtualDesktopResolution,
          onChangeEmulateModeset: formRef.setEmulateModeset,
          onToggleForceLargeAddressAware: formRef.handleToggleForceLargeAddressAware,
          onToggleWineMsync: formRef.handleToggleWineMsync,
          onToggleWineEsync: formRef.handleToggleWineEsync,
          onToggleMetalHud: formRef.handleToggleMetalHud,
          onToggleDxvkHud: formRef.handleToggleDxvkHud,
          onInstallRunnerViaBrew: formRef.handleInstallRunnerViaBrew,
          onInstallRunnerFromArchive: formRef.handleInstallRunnerFromArchive,
          onCheckRunnerUpdates: formRef.handleCheckRunnerUpdates,
          onUpdateRunner: formRef.handleUpdateRunner,
          onSwitchToStableCrossOver: formRef.handleSwitchToStableCrossOver,
          onDownloadRunner: formRef.handleDownloadRunner,
          onCancelRunnerOperation: formRef.handleCancelRunnerOperation,
        });
      };

      // Part A: handleSwitchToStableCrossOver
      const r1 = createDomain12DeepRenderer(Harness, {});
      r1.render();
      await Promise.resolve();
      await Promise.resolve();
      let t1 = r1.render();

      const switchPromise = formRef!.handleSwitchToStableCrossOver();
      t1 = r1.render();
      const selectEl1 = findByTestId(t1, 'compat-runner-select')!;
      expect(selectEl1.props.disabled).toBeFalsy();
      selectEl1.props.onChange({ target: { value: 'wine' } });
      t1 = r1.render();
      expect(formRef!.compatibilityLayer).toBe('wine');

      resolveSwitch({
        success: true,
        runnerType: 'crossover',
        message: 'Switched to CrossOver Stable.',
        detectedLayers: [crossoverLayer, previewLayer, wineLayer],
      });
      await switchPromise;
      await Promise.resolve();
      t1 = r1.render();

      expect(formRef!.compatibilityLayer).toBe('wine');
      expect(findByTestId(t1, 'compat-runner-select')!.props.value).toBe('wine');
      await formRef!.handleSave();
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ compatibilityLayer: 'wine' }),
        'steam'
      );
      r1.unmount();

      // Part B: handleUpdateRunner (stableSurpassesPreview)
      saveSpy.mockClear();
      let resolveUpdate!: (res: any) => void;
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveUpdate = resolve;
          })
      );

      const r2 = createDomain12DeepRenderer(Harness, {});
      r2.render();
      await Promise.resolve();
      await Promise.resolve();
      let t2 = r2.render();

      const updatePromise = formRef!.handleUpdateRunner();
      t2 = r2.render();
      findByTestId(t2, 'compat-runner-select')!.props.onChange({ target: { value: 'wine' } });
      t2 = r2.render();
      expect(formRef!.compatibilityLayer).toBe('wine');

      resolveUpdate({
        success: true,
        runnerType: 'crossover',
        message: 'Switched to CrossOver Stable.',
        detectedLayers: [crossoverLayer, previewLayer, wineLayer],
      });
      await updatePromise;
      await Promise.resolve();
      t2 = r2.render();

      expect(formRef!.compatibilityLayer).toBe('wine');
      expect(findByTestId(t2, 'compat-runner-select')!.props.value).toBe('wine');
      await formRef!.handleSave();
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ compatibilityLayer: 'wine' }),
        'steam'
      );
      r2.unmount();
    });

    it('Probe 1C-ii: closing and reopening GameLaunchConfigModal while updateCompatibilityLayer is pending prevents stale resolution from clobbering reopened modal', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const previewLayer = makeLayer('crossover_preview', tmpRoot, {
        availableBottles: ['OneLauncher', 'PreviewOnlyBottle'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          PreviewOnlyBottle: { wineArch: 'win64' },
        },
      });
      const wineLayer = makeLayer('wine', tmpRoot, { availableBottles: [] });
      const game = makeCanonicalGameFixture({
        id: 'steam-probe-1c-ii',
        title: 'Probe 1C-ii Modal Session Epoch',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Probe1Cii'),
            executablePath: path.join(tmpRoot, 'Games/Probe1Cii/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      const stableSurpassesInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        latestVersion: '27.1.0',
        updateAvailable: false,
        canAutoUpdate: false,
        stableSurpassesPreview: true,
        checkedAt: '2026-11-18T00:00:00.000Z',
      };

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        previewLayer,
        wineLayer,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        crossoverLayer,
        previewLayer,
        wineLayer,
      ]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
        crossover_preview: stableSurpassesInfo,
      });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({
        crossover_preview: stableSurpassesInfo,
      });
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Probe 1C-ii Modal Session Epoch',
        installPath: path.join(tmpRoot, 'Games/Probe1Cii'),
        executablePath: path.join(tmpRoot, 'Games/Probe1Cii/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({
          hostArch: 'arm64',
          installedRunners: ['crossover', 'crossover_preview', 'wine'],
        })
      );

      let savedConfig: any = {
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'PreviewOnlyBottle',
      };
      vi.spyOn(launcherService, 'getLaunchConfig').mockImplementation(() => savedConfig);

      let resolveStaleUpdate!: (res: any) => void;
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveStaleUpdate = resolve;
          })
      );

      // Part A: GameLaunchConfigModal with update-runner-btn (stableSurpassesPreview) isOpen: true -> false -> true
      const updateAvailableSurpassInfo: CompatibilityLayerUpdateInfo = {
        ...stableSurpassesInfo,
        updateAvailable: true,
      };
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
        crossover_preview: updateAvailableSurpassInfo,
      });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({
        crossover_preview: updateAvailableSurpassInfo,
      });

      const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      modal.render();
      await Promise.resolve();
      await Promise.resolve();
      let tree = modal.render();

      expect(findByTestId(tree, 'compat-runner-select')!.props.value).toBe('crossover_preview');
      const updateBtn = findByTestId(tree, 'update-runner-btn');
      expect(updateBtn).toBeDefined();
      const pendingClick = updateBtn!.props.onClick();

      // Close modal, change saved config to 'wine', and reopen modal while stale updateCompatibilityLayer is pending
      modal.render({ isOpen: false });
      savedConfig = {
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'wine',
      };
      tree = modal.render({ isOpen: true });
      await Promise.resolve();
      await Promise.resolve();
      tree = modal.render({ isOpen: true });
      expect(findByTestId(tree, 'compat-runner-select')!.props.value).toBe('wine');

      // Resolve the stale in-flight update from the closed session
      resolveStaleUpdate({
        success: true,
        runnerType: 'crossover',
        message: 'Switched to CrossOver Stable.',
        detectedLayers: [crossoverLayer, previewLayer, wineLayer],
      });
      await pendingClick;
      await Promise.resolve();
      await Promise.resolve();
      tree = modal.render({ isOpen: true });

      expect(findByTestId(tree, 'compat-runner-select')!.props.value).toBe('wine');
      modal.unmount();

      // Part B: handleSwitchToStableCrossOver directly across isOpen: true -> false -> true
      savedConfig = {
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'PreviewOnlyBottle',
      };
      let resolveStaleSwitch!: (res: any) => void;
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveStaleSwitch = resolve;
          })
      );
      let formRef: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const SessionHarness: React.FC<{ isOpen: boolean }> = ({ isOpen }) => {
        formRef = useGameLaunchConfigForm({
          isOpen,
          game,
          initialPlatformId: 'steam',
          onClose: vi.fn(),
        });
        return React.createElement('div');
      };
      const sessionModal = createDomain12DeepRenderer(SessionHarness, { isOpen: true });
      sessionModal.render();
      await Promise.resolve();
      await Promise.resolve();
      sessionModal.render();
      expect(formRef!.compatibilityLayer).toBe('crossover_preview');

      const pendingSwitch = formRef!.handleSwitchToStableCrossOver();
      sessionModal.render({ isOpen: true });
      expect(formRef!.isUpdatingRunner).toBe(true);
      sessionModal.render({ isOpen: false });
      savedConfig = {
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'wine',
      };
      sessionModal.render({ isOpen: true });
      await Promise.resolve();
      await Promise.resolve();
      sessionModal.render({ isOpen: true });
      expect(formRef!.compatibilityLayer).toBe('wine');
      expect(formRef!.isUpdatingRunner).toBe(false);

      resolveStaleSwitch({
        success: true,
        runnerType: 'crossover',
        message: 'Switched to CrossOver Stable.',
        detectedLayers: [crossoverLayer, previewLayer, wineLayer],
      });
      await pendingSwitch;
      await Promise.resolve();
      sessionModal.render({ isOpen: true });
      expect(formRef!.compatibilityLayer).toBe('wine');
      expect(formRef!.isUpdatingRunner).toBe(false);
      sessionModal.unmount();
    });

    it('Probe 1C-iii: switching epic -> steam -> handleSwitchToStableCrossOver -> epic marks hasUnsavedChanges true when steam draft updates in background', async () => {
      const crossoverLayer = makeLayer('crossover', tmpRoot, {
        availableBottles: ['OneLauncher'],
        bottleDetails: { OneLauncher: { wineArch: 'win64' } },
      });
      const previewLayer = makeLayer('crossover_preview', tmpRoot, {
        availableBottles: ['OneLauncher', 'PreviewOnlyBottle'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          PreviewOnlyBottle: { wineArch: 'win64' },
        },
      });
      const wineLayer = makeLayer('wine', tmpRoot, { availableBottles: [] });
      const game = makeCanonicalGameFixture({
        id: 'multi-probe-1c-iii',
        title: 'Probe 1C-iii Dirty Inactive Tab',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Probe1CiiiSteam'),
            executablePath: path.join(tmpRoot, 'Games/Probe1CiiiSteam/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
          {
            platformId: 'epic',
            platformGameId: 'epic-1c-iii',
            installed: true,
            installPath: path.join(tmpRoot, 'Games/Probe1CiiiEpic'),
            executablePath: path.join(tmpRoot, 'Games/Probe1CiiiEpic/game.exe'),
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      const stableSurpassesInfo: CompatibilityLayerUpdateInfo = {
        runnerType: 'crossover_preview',
        installed: true,
        installedVersion: '27.0.0',
        latestVersion: '27.1.0',
        updateAvailable: true,
        canAutoUpdate: false,
        stableSurpassesPreview: true,
        checkedAt: '2026-11-18T00:00:00.000Z',
      };

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        crossoverLayer,
        previewLayer,
        wineLayer,
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        crossoverLayer,
        previewLayer,
        wineLayer,
      ]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
        crossover_preview: stableSurpassesInfo,
      });
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({
        crossover_preview: stableSurpassesInfo,
      });
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-1091500',
        platformId: 'steam',
        platformGameId: '1091500',
        title: 'Probe 1C-iii Dirty Inactive Tab',
        installPath: path.join(tmpRoot, 'Games/Probe1CiiiSteam'),
        executablePath: path.join(tmpRoot, 'Games/Probe1CiiiSteam/game.exe'),
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(
        makeSnapshot({
          hostArch: 'arm64',
          installedRunners: ['crossover', 'crossover_preview', 'wine'],
        })
      );
      vi.spyOn(launcherService, 'getLaunchConfig').mockImplementation((_gId, platId) =>
        platId === 'epic'
          ? ({
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'wine',
            } as any)
          : ({
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover_preview',
              wineBottleName: 'PreviewOnlyBottle',
            } as any)
      );

      let resolveSwitch!: (res: any) => void;
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSwitch = resolve;
          })
      );

      const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'epic',
        onClose: vi.fn(),
      });
      modal.render();
      await Promise.resolve();
      await Promise.resolve();
      let tree = modal.render();

      const getSaveButton = (root: unknown) =>
        findElements(
          root,
          (el) => el.type === 'button' && getTextContent(el).includes('Save Configuration')
        )[0]!;

      expect(findByTestId(tree, 'compat-runner-select')!.props.value).toBe('wine');
      expect(getSaveButton(tree).props['data-has-unsaved-changes']).toBe('false');

      // Switch epic -> steam
      const steamTab = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Steam')
      )[0]!;
      steamTab.props.onClick();
      tree = modal.render();
      expect(findByTestId(tree, 'compat-runner-select')!.props.value).toBe('crossover_preview');

      // Start switch on steam via update-runner-btn, then switch back to epic while pending
      const switchPromise = findByTestId(tree, 'update-runner-btn')!.props.onClick();
      const epicTab = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Epic')
      )[0]!;
      epicTab.props.onClick();
      tree = modal.render();
      expect(findByTestId(tree, 'compat-runner-select')!.props.value).toBe('wine');
      expect(getSaveButton(tree).props['data-has-unsaved-changes']).toBe('false');

      // Resolve switch while active tab is epic
      resolveSwitch({
        success: true,
        runnerType: 'crossover',
        message: 'Switched to CrossOver Stable.',
        detectedLayers: [crossoverLayer, previewLayer, wineLayer],
      });
      await switchPromise;
      await Promise.resolve();
      tree = modal.render();

      expect(findByTestId(tree, 'compat-runner-select')!.props.value).toBe('wine');
      expect(getSaveButton(tree).props['data-has-unsaved-changes']).toBe('true');

      // Switching back to steam remains dirty and reflects crossover
      findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Steam')
      )[0]!.props.onClick();
      tree = modal.render();
      expect(findByTestId(tree, 'compat-runner-select')!.props.value).toBe('crossover');
      expect(getSaveButton(tree).props['data-has-unsaved-changes']).toBe('true');
      modal.unmount();

      // Also verify direct handleSwitchToStableCrossOver updates hasUnsavedChanges when on epic
      let resolveDirectSwitch!: (res: any) => void;
      vi.spyOn(launcherService, 'updateCompatibilityLayer').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDirectSwitch = resolve;
          })
      );
      let formRef: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const DirtyHarness: React.FC = () => {
        formRef = useGameLaunchConfigForm({
          isOpen: true,
          game,
          initialPlatformId: 'epic',
          onClose: vi.fn(),
        });
        return React.createElement('div');
      };
      const dirtyRenderer = createDomain12DeepRenderer(DirtyHarness, {});
      dirtyRenderer.render();
      await Promise.resolve();
      await Promise.resolve();
      dirtyRenderer.render();

      expect(formRef!.hasUnsavedChanges).toBe(false);
      formRef!.handleSelectStorefront('steam');
      dirtyRenderer.render();
      const directPromise = formRef!.handleSwitchToStableCrossOver();
      formRef!.handleSelectStorefront('epic');
      dirtyRenderer.render();
      expect(formRef!.hasUnsavedChanges).toBe(false);

      resolveDirectSwitch({
        success: true,
        runnerType: 'crossover',
        message: 'Switched to CrossOver Stable.',
        detectedLayers: [crossoverLayer, previewLayer, wineLayer],
      });
      await directPromise;
      await Promise.resolve();
      dirtyRenderer.render();

      expect(formRef!.preferredPlatformId).toBe('epic');
      expect(formRef!.compatibilityLayer).toBe('wine');
      expect(formRef!.hasUnsavedChanges).toBe(true);
      dirtyRenderer.unmount();
    });

    it('Probe 1B-2 & 1B-3: SystemSetupWizardModal synchronous handler batches post-probeHealth preserve Install Steam (Windows) and bottle creation', async () => {
      const intelBottleOnlySnap = makeSnapshot({
        hostArch: 'arm64',
        installedRunners: ['crossover', 'crossover_preview_arm64'],
        availableBottles: [
          {
            name: 'OneLauncher',
            path: path.join(tmpRoot, 'CrossOver/Bottles/OneLauncher'),
            runnerType: 'crossover',
            wineArch: 'win64',
            bottleArch: 'win64',
            hasSteam: true,
            hasGogGalaxy: false,
            hasEpicLauncher: false,
            isSandboxed: false,
          },
        ],
      });
      intelBottleOnlySnap.components.bottle_default = {
        ...intelBottleOnlySnap.components.bottle_default,
        status: 'ready',
      };
      intelBottleOnlySnap.components.bottle_steam = {
        ...intelBottleOnlySnap.components.bottle_steam,
        status: 'ready',
      };

      const blankWizardState = {
        schemaVersion: 1 as const,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
      };

      vi.spyOn(environmentSetupService, 'getLastSnapshot').mockReturnValue(intelBottleOnlySnap);
      vi.spyOn(environmentSetupService, 'getWizardState').mockReturnValue(blankWizardState);
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue(blankWizardState);
      vi.spyOn(environmentSetupService, 'probeHealth').mockResolvedValue(intelBottleOnlySnap);

      // Probe 1B-2: click setup-bottle-mode-create + type 'SyncBatchCustomBottle' in one synchronous batch without re-rendering between them
      const wizardA = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      wizardA.render();
      await Promise.resolve();
      await Promise.resolve();
      let treeA = wizardA.render();

      const createRadio = findByTestId(treeA, 'setup-bottle-mode-create')!;
      const nameInputA = findElements(
        treeA,
        (el) => el.type === 'input' && el.props?.['data-testid'] === 'setup-bottle-name-input'
      )[0]!;
      createRadio.props.onClick();
      nameInputA.props.onChange({ target: { value: 'SyncBatchCustomBottle' } });
      treeA = wizardA.render();

      findByTestId(treeA, 'setup-next-step-btn')!.props.onClick();
      treeA = wizardA.render();
      findByTestId(treeA, 'setup-next-step-btn')!.props.onClick();
      treeA = wizardA.render();

      const summaryA = getTextContent(findByTestId(treeA, 'setup-step-summary'));
      expect(summaryA).toContain('Create "SyncBatchCustomBottle" bottle');
      expect(summaryA).toContain('Install Steam (Windows)');
      wizardA.unmount();

      // Probe 1B-3: click setup-runner-crossover-preview-arm64 + type 'SyncBatchFexBottle' in one synchronous batch without re-rendering between them
      const wizardB = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      wizardB.render();
      await Promise.resolve();
      await Promise.resolve();
      let treeB = wizardB.render();

      const arm64RunnerBtn = findByTestId(treeB, 'setup-runner-crossover-preview-arm64')!;
      const nameInputB = findElements(
        treeB,
        (el) => el.type === 'input' && el.props?.['data-testid'] === 'setup-bottle-name-input'
      )[0]!;
      arm64RunnerBtn.props.onClick();
      nameInputB.props.onChange({ target: { value: 'SyncBatchFexBottle' } });
      treeB = wizardB.render();

      findByTestId(treeB, 'setup-next-step-btn')!.props.onClick();
      treeB = wizardB.render();
      findByTestId(treeB, 'setup-next-step-btn')!.props.onClick();
      treeB = wizardB.render();

      const summaryB = getTextContent(findByTestId(treeB, 'setup-step-summary'));
      expect(summaryB).toContain('Create "SyncBatchFexBottle" bottle');
      expect(summaryB).toContain('Install Steam (Windows)');
      wizardB.unmount();
    });
  });
});
