import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  type CompatibilityLayerInfo,
  type GameLaunchConfig,
  type InstalledGameRecord,
  type LauncherActionResult,
} from '../src/contracts/launcher';
import type {
  EnvironmentSetupProgressEvent,
  GuidedClientLoginResult,
  RunEnvironmentSetupResult,
} from '../src/contracts/environmentSetup';
import {
  buildFallbackEnvironmentSnapshot,
  environmentSetupService,
} from '../src/services/launcher/environmentSetupService';
import { launcherService } from '../src/services/launcher/launcherService';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';

interface VNodeElement {
  type: unknown;
  props?: Record<string, unknown> & { children?: unknown };
}

function isVNodeElement(node: unknown): node is VNodeElement {
  return Boolean(node && typeof node === 'object' && !Array.isArray(node) && 'type' in node);
}

function findVNodes(root: unknown, predicate: (node: VNodeElement) => boolean): VNodeElement[] {
  const matches: VNodeElement[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (isVNodeElement(node)) {
      if (predicate(node)) matches.push(node);
      if (node.props?.children !== undefined) {
        visit(node.props.children);
      }
    }
  };
  visit(root);
  return matches;
}

function findByTestId(root: unknown, testId: string): VNodeElement | undefined {
  return findVNodes(root, (n) => n.props?.['data-testid'] === testId)[0];
}

function extractText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isVNodeElement(node) && node.props?.children !== undefined) {
    return extractText(node.props.children);
  }
  return '';
}

function auditModernWebAndA11y(tree: unknown): string[] {
  const violations: string[] = [];
  const elements = findVNodes(tree, (n) => typeof n.type === 'string');
  const ids = new Map<string, VNodeElement>();

  for (const el of elements) {
    const tag = String(el.type);
    const props = el.props ?? {};
    const id = props.id;
    if (typeof id === 'string' && id.trim()) {
      if (ids.has(id)) {
        violations.push(`duplicate-id:${id}`);
      } else {
        ids.set(id, el);
      }
    }
    if (tag === 'button') {
      const btnType = props.type;
      if (btnType !== 'button' && btnType !== 'submit' && btnType !== 'reset') {
        violations.push(`button-missing-type:${String(props['data-testid'] ?? extractText(el))}`);
      }
    }
    if (tag === 'svg') {
      if (props['aria-hidden'] !== 'true' && props['aria-hidden'] !== true) {
        violations.push(`svg-missing-aria-hidden:${String(props.className ?? '')}`);
      }
    }
  }

  return violations;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {};
  let rejectFn: (err: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

const memStorage = createMemoryStorage();

function installDomGlobals(electronApiOverrides?: Record<string, unknown>): void {
  const g = globalThis as Record<string, unknown>;
  g.localStorage = memStorage;
  if (typeof g.CustomEvent !== 'function') {
    g.CustomEvent = class SyntheticCustomEvent<T = unknown> {
      public readonly type: string;
      public readonly detail: T | undefined;
      constructor(type: string, init?: { detail?: T }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  }
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  g.window = {
    localStorage: memStorage,
    location: { hostname: '' },
    navigator: { userAgent: 'Macintosh' },
    electronAPI: {
      platform: 'darwin',
      ...(electronApiOverrides || {}),
    },
    addEventListener: (ev: string, fn: (e: unknown) => void) => {
      const list = listeners.get(ev) ?? [];
      list.push(fn);
      listeners.set(ev, list);
    },
    removeEventListener: (ev: string, fn: (e: unknown) => void) => {
      const list = listeners.get(ev);
      if (list) {
        listeners.set(
          ev,
          list.filter((item) => item !== fn)
        );
      }
    },
    dispatchEvent: (event: { type?: string }) => {
      const list = event?.type ? (listeners.get(event.type) ?? []).slice() : [];
      for (const fn of list) fn(event);
      return true;
    },
  };
}

function makeLayerFixtures(arm64SteamState?: {
  hasSteam: boolean;
  steamSignedIn: boolean;
  installedSteamAppIds?: number[];
}): CompatibilityLayerInfo[] {
  const arm64Details = arm64SteamState ?? {
    hasSteam: false,
    steamSignedIn: false,
    installedSteamAppIds: [],
  };

  const stableWin64: CompatibilityLayerInfo = {
    id: 'crossover',
    type: 'crossover',
    name: 'CrossOver',
    binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
    appPath: '/Applications/CrossOver.app',
    bottlesDir: '/tmp/ol-p3-ui-test/CrossOver/Bottles',
    availableBottles: ['OneLauncher'],
    available: true,
    version: '26.0.0',
    hostArch: 'arm64',
    supportedBottleArches: ['win64'],
    bottleDetails: {
      OneLauncher: {
        wineArch: 'win64',
        hasSteam: true,
        steamSignedIn: true,
        installedSteamAppIds: [990042],
      },
    },
  };

  const previewWin64: CompatibilityLayerInfo = {
    id: 'crossover_preview',
    type: 'crossover_preview',
    name: 'CrossOver Preview',
    binaryPath: '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
    appPath: '/Applications/CrossOver Preview.app',
    bottlesDir: '/tmp/ol-p3-ui-test/CrossOver Preview/Bottles',
    availableBottles: ['OneLauncher', 'SteamAlt'],
    available: true,
    version: '26.1.0',
    hostArch: 'arm64',
    supportedBottleArches: ['win64'],
    bottleDetails: {
      OneLauncher: {
        wineArch: 'win64',
        previewEnabled: true,
        hasSteam: true,
        steamSignedIn: true,
        installedSteamAppIds: [990042],
      },
      SteamAlt: {
        wineArch: 'win64',
        previewEnabled: true,
        hasSteam: true,
        steamSignedIn: false,
        installedSteamAppIds: [],
      },
    },
  };

  const previewArm64: CompatibilityLayerInfo = {
    id: 'crossover_preview_arm64',
    type: 'crossover_preview_arm64',
    name: 'CrossOver Preview (arm64 / FEX)',
    binaryPath: '/Applications/CrossOver Preview ARM64.app/Contents/SharedSupport/CrossOver/bin/wine',
    appPath: '/Applications/CrossOver Preview ARM64.app',
    bottlesDir: '/tmp/ol-p3-ui-test/CrossOver Preview/Bottles',
    availableBottles: ['OneLauncher-arm64'],
    available: true,
    version: '26.1.0-arm64',
    hostArch: 'arm64',
    previewBranch: 'arm64',
    supportedBottleArches: ['arm64'],
    bottleDetails: {
      'OneLauncher-arm64': {
        wineArch: 'arm64',
        previewEnabled: true,
        hasSteam: arm64Details.hasSteam,
        steamSignedIn: arm64Details.steamSignedIn,
        ...(arm64Details.installedSteamAppIds !== undefined
          ? { installedSteamAppIds: arm64Details.installedSteamAppIds }
          : {}),
      },
    },
  };

  return [previewArm64, previewWin64, stableWin64];
}

describe('Phase 3 — 1-Click Bottle Steam Provisioning & Link UI', () => {
  beforeEach(() => {
    memStorage.clear();
    installDomGlobals();
    launcherService.savePerformanceSettings({ ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Contract extensions expose installedSteamAppIds on bottleDetails and chosenRunnerType on LauncherActionResult', () => {
    const layers = makeLayerFixtures({
      hasSteam: true,
      steamSignedIn: true,
      installedSteamAppIds: [2320, 990042],
    });
    expect(layers[0].bottleDetails?.['OneLauncher-arm64']?.installedSteamAppIds).toEqual([
      2320, 990042,
    ]);

    const res: LauncherActionResult = {
      success: false,
      errorCode: 'BOTTLE_STEAM_NOT_INSTALLED',
      targetBottleName: 'OneLauncher-arm64',
      chosenRunnerType: 'crossover_preview_arm64',
      recommendedRunnerType: 'crossover',
      error: 'Windows Steam is missing.',
    };
    expect(res.chosenRunnerType).toBe('crossover_preview_arm64');
  });

  it('2. startGuidedLogin refreshes both detectCompatibilityLayers and detectInstalledStorefrontClients, and provisionAndSignInBottleSteam orchestrates install + progress + guided login + link-only + cancel', async () => {
    let progressCb: ((ev: EnvironmentSetupProgressEvent) => void) | null = null;
    const cancelSetupIpc = vi.fn().mockResolvedValue({ success: true, cancelled: true });
    const cancelGuidedIpc = vi.fn().mockResolvedValue({ success: true, cancelled: true });
    const startGuidedIpc = vi.fn().mockResolvedValue({
      success: true,
      targetId: 'bottle_steam',
      authenticated: true,
      probeState: {
        targetId: 'bottle_steam',
        storefrontId: 'steam',
        scope: 'bottle',
        label: 'Windows Steam (Bottle)',
        installed: true,
        authenticated: true,
        accountMatchesOneLauncher: true,
        statusSummary: 'Signed in.',
      },
      message: 'Signed in to Steam inside OneLauncher-arm64.',
    } satisfies GuidedClientLoginResult);

    installDomGlobals({
      onEnvironmentSetupProgress: (cb: (ev: EnvironmentSetupProgressEvent) => void) => {
        progressCb = cb;
        return () => {
          progressCb = null;
        };
      },
      startGuidedClientLogin: startGuidedIpc,
      cancelEnvironmentSetup: cancelSetupIpc,
      cancelGuidedClientLogin: cancelGuidedIpc,
    });

    const detectLayersSpy = vi
      .spyOn(launcherService, 'detectCompatibilityLayers')
      .mockResolvedValue(makeLayerFixtures({ hasSteam: true, steamSignedIn: true, installedSteamAppIds: [990042] }));
    const detectClientsSpy = vi
      .spyOn(launcherService, 'detectInstalledStorefrontClients')
      .mockResolvedValue({ steam: true, gog: false, epic: false });

    // 2a. startGuidedLogin directly triggers BOTH detectCompatibilityLayers & detectInstalledStorefrontClients
    const directLogin = await environmentSetupService.startGuidedLogin({
      targetId: 'bottle_steam',
      runnerType: 'crossover_preview_arm64',
      bottleName: 'OneLauncher-arm64',
      autoCloseOnSuccess: true,
    });
    expect(directLogin.authenticated).toBe(true);
    expect(detectLayersSpy).toHaveBeenCalledTimes(1);
    expect(detectClientsSpy).toHaveBeenCalledTimes(1);

    // 2b. provisionAndSignInBottleSteam (install + guided sign-in + progress forwarding)
    const fallbackSnap = buildFallbackEnvironmentSnapshot(['steam']);
    const runSetupSpy = vi
      .spyOn(environmentSetupService, 'runSetupTasks')
      .mockImplementation(async (req) => {
        progressCb?.({
          runId: 'run-p3-1',
          componentId: 'bottle_steam',
          action: 'install_client',
          stepIndex: 0,
          totalSteps: 1,
          phase: 'downloading',
          progressPercent: 45,
          message: 'Downloading Windows Steam installer (45%)...',
        });
        return {
          success: true,
          runId: req.runId || 'run-p3-1',
          outcomes: [
            {
              componentId: 'bottle_steam',
              action: 'install_client',
              status: 'completed',
              message: 'Installed Windows Steam and linked 2 games in "OneLauncher-arm64".',
            },
          ],
          snapshot: fallbackSnap,
        } satisfies RunEnvironmentSetupResult;
      });
    const guidedSpy = vi.spyOn(environmentSetupService, 'startGuidedLogin');

    const phases: string[] = [];
    const installRes = await environmentSetupService.provisionAndSignInBottleSteam({
      runnerType: 'crossover_preview_arm64',
      bottleName: 'OneLauncher-arm64',
      needsInstall: true,
      needsSignIn: true,
      onPhaseChange: (msg) => phases.push(msg),
    });

    expect(installRes.success).toBe(true);
    expect(installRes.installed).toBe(true);
    expect(installRes.authenticated).toBe(true);
    expect(runSetupSpy).toHaveBeenCalledWith({
      tasks: [
        {
          componentId: 'bottle_steam',
          action: 'install_client',
          runnerType: 'crossover_preview_arm64',
          bottleName: 'OneLauncher-arm64',
        },
      ],
      connectedStorefronts: ['steam'],
    });
    expect(guidedSpy).toHaveBeenCalledWith({
      targetId: 'bottle_steam',
      runnerType: 'crossover_preview_arm64',
      bottleName: 'OneLauncher-arm64',
      autoCloseOnSuccess: true,
    });
    expect(phases.some((m) => m.includes('Downloading Windows Steam installer'))).toBe(true);
    expect(phases.some((m) => m.includes('Steam opened in "OneLauncher-arm64"'))).toBe(true);

    // 2c. link-only skips startGuidedLogin while running install_client and refreshing layers
    guidedSpy.mockClear();
    const linkRes = await environmentSetupService.provisionAndSignInBottleSteam({
      runnerType: 'crossover_preview_arm64',
      bottleName: 'OneLauncher-arm64',
      needsInstall: false,
      needsSignIn: false,
    });
    expect(linkRes.success).toBe(true);
    expect(linkRes.installed).toBe(true);
    expect(guidedSpy).not.toHaveBeenCalled();

    // 2d. Step 1 failure short-circuits before guided login
    runSetupSpy.mockResolvedValueOnce({
      success: false,
      runId: 'run-fail',
      outcomes: [
        {
          componentId: 'bottle_steam',
          action: 'install_client',
          status: 'failed',
          message: 'Installer failed.',
          error: 'Signature verification failed.',
        },
      ],
      snapshot: fallbackSnap,
      error: 'Signature verification failed.',
    });
    const failRes = await environmentSetupService.provisionAndSignInBottleSteam({
      runnerType: 'crossover_preview_arm64',
      bottleName: 'OneLauncher-arm64',
      needsInstall: true,
      needsSignIn: true,
    });
    expect(failRes.success).toBe(false);
    expect(failRes.error).toContain('Signature verification failed');
    expect(guidedSpy).not.toHaveBeenCalled();

    // 2e. cancelBottleSteamProvisioning cancels active run cleanly
    const deferredRun = createDeferred<RunEnvironmentSetupResult>();
    runSetupSpy.mockReturnValueOnce(deferredRun.promise);
    const pendingProvision = environmentSetupService.provisionAndSignInBottleSteam({
      runnerType: 'crossover_preview_arm64',
      bottleName: 'OneLauncher-arm64',
      needsInstall: true,
      needsSignIn: true,
    });
    await environmentSetupService.cancelBottleSteamProvisioning();
    expect(cancelGuidedIpc).toHaveBeenCalledWith('bottle_steam');
    deferredRun.resolve({
      success: false,
      cancelled: true,
      runId: 'run-cancel',
      outcomes: [
        {
          componentId: 'bottle_steam',
          action: 'install_client',
          status: 'cancelled',
          message: 'Cancelled.',
        },
      ],
      snapshot: fallbackSnap,
    });
    const cancelledRes = await pendingProvision;
    expect(cancelledRes.success).toBe(false);
    expect(cancelledRes.cancelled).toBe(true);
    expect(guidedSpy).not.toHaveBeenCalled();
  });
});

describe('Phase 3 — Launch Config Modal & ActionBar 1-Click Bottle Steam Fix UI', () => {
  beforeEach(() => {
    memStorage.clear();
    installDomGlobals();
    launcherService.savePerformanceSettings({ ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('3. GameLaunchConfigModal renders 1-click Install & Set Up Steam button, live inline progress + Cancel, and transitions to Steam Ready + linked mismatch text', async () => {
    const installPath =
      '/tmp/ol-p3-ui-test/CrossOver Preview/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/SynthQuest';
    const executablePath = `${installPath}/SynthQuest.exe`;

    const game = makeCanonicalGameFixture({
      id: 'steam-990042',
      title: 'Synth Quest',
      steamAppId: 990042,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '990042',
          installed: true,
          installPath,
          executablePath,
          isWindowsBinaryOnMac: true,
        },
      ],
    });
    const installedRec: InstalledGameRecord = {
      platformId: 'steam',
      platformGameId: '990042',
      appId: 990042,
      title: 'Synth Quest',
      installPath,
      executablePath,
      isWindowsBinaryOnMac: true,
    };
    const pinnedArm64Config: GameLaunchConfig = {
      gameId: game.id,
      preferredPlatformId: 'steam',
      launchMethod: 'compatibility_layer',
      compatibilityLayer: 'crossover_preview_arm64',
    };

    const initialLayers = makeLayerFixtures({
      hasSteam: false,
      steamSignedIn: false,
      installedSteamAppIds: [],
    });
    const readyLayers = makeLayerFixtures({
      hasSteam: true,
      steamSignedIn: true,
      installedSteamAppIds: [990042],
    });

    vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(initialLayers);
    const detectLayersSpy = vi
      .spyOn(launcherService, 'detectCompatibilityLayers')
      .mockResolvedValue(initialLayers);
    vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
    vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
    vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue({
      steam: true,
      gog: false,
      epic: false,
    });
    vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue(installedRec);
    vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(pinnedArm64Config);

    const deferredFix = createDeferred<{
      success: boolean;
      installed: boolean;
      authenticated: boolean;
      message: string;
    }>();
    let capturedOnPhaseChange: ((msg: string) => void) | undefined;
    const provisionSpy = vi
      .spyOn(environmentSetupService, 'provisionAndSignInBottleSteam')
      .mockImplementation((params) => {
        capturedOnPhaseChange = params.onPhaseChange;
        return deferredFix.promise;
      });

    const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
      isOpen: true,
      game,
      initialPlatformId: 'steam',
      onClose: vi.fn(),
    });
    renderer.render();
    await Promise.resolve();
    let tree = renderer.render();

    expect(auditModernWebAndA11y(tree)).toEqual([]);
    const missingBanner = findByTestId(tree, 'compat-bottle-steam-missing-warning');
    expect(missingBanner?.props?.role).toBe('alert');
    const installBtn = findByTestId(missingBanner, 'compat-fix-install-bottle-steam-btn');
    expect(installBtn?.props?.type).toBe('button');
    expect(extractText(installBtn)).toContain('Install & Set Up Steam in OneLauncher-arm64');

    // Click Install & Set Up Steam -> inline progress + Cancel rendered inside banner
    const fixPromise = (installBtn?.props?.onClick as () => Promise<void>)();
    tree = renderer.render();
    expect(auditModernWebAndA11y(tree)).toEqual([]);

    const progress = findByTestId(tree, 'compat-bottle-steam-fix-progress');
    expect(progress?.props?.role).toBe('status');
    expect(progress?.props?.['aria-live']).toBe('polite');
    expect(extractText(progress)).toContain('Installing Windows Steam into "OneLauncher-arm64"');
    const cancelBtn = findByTestId(progress, 'compat-cancel-bottle-steam-fix-btn');
    expect(cancelBtn?.props?.type).toBe('button');
    expect(extractText(cancelBtn)).toContain('Cancel');

    // Emit live phase change update
    capturedOnPhaseChange?.('Steam opened in "OneLauncher-arm64" — sign in once (QR or password) to enable Steam Cloud...');
    tree = renderer.render();
    expect(extractText(findByTestId(tree, 'compat-bottle-steam-fix-progress'))).toContain(
      'Steam opened in "OneLauncher-arm64"'
    );

    // Complete provisioning and refresh layers to Steam Ready + linked app
    detectLayersSpy.mockResolvedValueOnce(readyLayers);
    deferredFix.resolve({
      success: true,
      installed: true,
      authenticated: true,
      message: 'Steam is ready and signed in inside "OneLauncher-arm64".',
    });
    await fixPromise;
    tree = renderer.render();

    expect(provisionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerType: 'crossover_preview_arm64',
        bottleName: 'OneLauncher-arm64',
        needsInstall: true,
        needsSignIn: true,
      })
    );
    expect(auditModernWebAndA11y(tree)).toEqual([]);
    expect(findByTestId(tree, 'compat-bottle-steam-missing-warning')).toBeUndefined();
    expect(findByTestId(tree, 'compat-bottle-steam-fix-progress')).toBeUndefined();
    const readyChip = findByTestId(tree, 'compat-bottle-steam-readiness-chip');
    expect(readyChip?.props?.['data-steam-readiness']).toBe('ready');
    expect(extractText(readyChip)).toContain('Steam Ready');

    // Mismatch banner now clearly explains this game & Steam Cloud are linked in OneLauncher-arm64
    const mismatchBanner = findByTestId(tree, 'compat-install-bottle-mismatch-warning');
    expect(extractText(mismatchBanner)).toContain(
      'This game & Steam Cloud are linked in “OneLauncher-arm64”'
    );
    expect(findByTestId(mismatchBanner, 'compat-fix-link-steam-game-btn')).toBeUndefined();
    const successFeedback = findByTestId(tree, 'compat-bottle-steam-fix-success');
    expect(successFeedback?.props?.role).toBe('status');
    expect(extractText(successFeedback)).toContain('OneLauncher-arm64');
    renderer.unmount();
  });

  it('4. GameLaunchConfigModal renders Sign In to Steam warning when steamSignedIn=false, Link Game button when unlinked, and wires Cancel cleanly', async () => {
    const installPath =
      '/tmp/ol-p3-ui-test/CrossOver Preview/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/SynthQuest';
    const executablePath = `${installPath}/SynthQuest.exe`;

    // Omit game.steamAppId so numericSteamAppId must resolve from platformGameId / game.id
    const game = makeCanonicalGameFixture({
      id: 'steam-990042',
      title: 'Synth Quest',
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '990042',
          installed: true,
          installPath,
          executablePath,
          isWindowsBinaryOnMac: true,
        },
      ],
    });
    delete game.steamAppId;

    const installedRec: InstalledGameRecord = {
      platformId: 'steam',
      platformGameId: '990042',
      title: 'Synth Quest',
      installPath,
      executablePath,
      isWindowsBinaryOnMac: true,
    };

    const unlinkedSignInNeededLayers = makeLayerFixtures({
      hasSteam: true,
      steamSignedIn: false,
      installedSteamAppIds: [],
    });
    const signedInUnlinkedLayers = makeLayerFixtures({
      hasSteam: true,
      steamSignedIn: true,
      installedSteamAppIds: [],
    });
    const signedInLinkedLayers = makeLayerFixtures({
      hasSteam: true,
      steamSignedIn: true,
      installedSteamAppIds: [990042],
    });

    vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(unlinkedSignInNeededLayers);
    const detectLayersSpy = vi
      .spyOn(launcherService, 'detectCompatibilityLayers')
      .mockResolvedValue(unlinkedSignInNeededLayers);
    vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
    vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
    vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue({
      steam: true,
      gog: false,
      epic: false,
    });
    vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue(installedRec);
    vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
      gameId: game.id,
      preferredPlatformId: 'steam',
      launchMethod: 'compatibility_layer',
      compatibilityLayer: 'crossover_preview_arm64',
    });

    const provisionSpy = vi
      .spyOn(environmentSetupService, 'provisionAndSignInBottleSteam')
      .mockResolvedValueOnce({
        success: true,
        installed: true,
        authenticated: true,
        message: 'Signed in to Steam inside "OneLauncher-arm64".',
      });
    const cancelSpy = vi
      .spyOn(environmentSetupService, 'cancelBottleSteamProvisioning')
      .mockResolvedValue(undefined);

    const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
      isOpen: true,
      game,
      initialPlatformId: 'steam',
      onClose: vi.fn(),
    });
    renderer.render();
    await Promise.resolve();
    let tree = renderer.render();
    expect(auditModernWebAndA11y(tree)).toEqual([]);

    // Sign-In Needed banner + button
    const signInBanner = findByTestId(tree, 'compat-bottle-steam-signin-warning');
    expect(signInBanner?.props?.role).toBe('alert');
    const signInBtn = findByTestId(signInBanner, 'compat-fix-signin-bottle-steam-btn');
    expect(signInBtn?.props?.type).toBe('button');
    expect(extractText(signInBtn)).toContain('Sign In to Steam (OneLauncher-arm64)');

    // Link Game button is also present inside compat-install-bottle-mismatch-warning alongside Switch button
    const mismatchBanner = findByTestId(tree, 'compat-install-bottle-mismatch-warning');
    expect(findByTestId(mismatchBanner, 'compat-fix-link-steam-game-btn')).toBeDefined();
    expect(findByTestId(mismatchBanner, 'compat-align-install-bottle-btn')).toBeDefined();

    // Run Sign-In Only -> transitions to signedInUnlinkedLayers
    detectLayersSpy.mockResolvedValueOnce(signedInUnlinkedLayers);
    await (signInBtn?.props?.onClick as () => Promise<void>)();
    tree = renderer.render();
    expect(provisionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerType: 'crossover_preview_arm64',
        bottleName: 'OneLauncher-arm64',
        needsInstall: false,
        needsSignIn: true,
      })
    );
    expect(findByTestId(tree, 'compat-bottle-steam-signin-warning')).toBeUndefined();

    // Click Link Game -> verify cancel button triggers cancelBottleSteamProvisioning
    const deferredLink = createDeferred<{
      success: boolean;
      installed: boolean;
      authenticated: boolean;
      cancelled?: boolean;
      message: string;
    }>();
    provisionSpy.mockReturnValueOnce(deferredLink.promise);
    const linkBtn = findByTestId(tree, 'compat-fix-link-steam-game-btn');
    expect(linkBtn?.props?.type).toBe('button');
    expect(extractText(linkBtn)).toContain('Link Game into OneLauncher-arm64');
    const linkPromise = (linkBtn?.props?.onClick as () => Promise<void>)();
    tree = renderer.render();

    const cancelBtn = findByTestId(tree, 'compat-cancel-bottle-steam-fix-btn');
    expect(cancelBtn).toBeDefined();
    await (cancelBtn?.props?.onClick as () => Promise<void>)();
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    detectLayersSpy.mockResolvedValueOnce(signedInUnlinkedLayers);
    deferredLink.resolve({
      success: false,
      installed: true,
      authenticated: true,
      cancelled: true,
      message: 'Cancelled Steam setup in "OneLauncher-arm64".',
    });
    await linkPromise;
    tree = renderer.render();
    expect(findByTestId(tree, 'compat-bottle-steam-fix-error')?.props?.role).toBe('alert');

    // Retry Link Game and succeed -> removes Link button & updates mismatch banner text
    provisionSpy.mockResolvedValueOnce({
      success: true,
      installed: true,
      authenticated: true,
      message: 'Linked installed Steam games into "OneLauncher-arm64".',
    });
    detectLayersSpy.mockResolvedValueOnce(signedInLinkedLayers);
    await (findByTestId(tree, 'compat-fix-link-steam-game-btn')?.props?.onClick as () => Promise<void>)();
    tree = renderer.render();

    expect(provisionSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runnerType: 'crossover_preview_arm64',
        bottleName: 'OneLauncher-arm64',
        needsInstall: false,
        needsSignIn: false,
      })
    );
    expect(findByTestId(tree, 'compat-fix-link-steam-game-btn')).toBeUndefined();
    expect(extractText(findByTestId(tree, 'compat-install-bottle-mismatch-warning'))).toContain(
      'This game & Steam Cloud are linked in “OneLauncher-arm64”'
    );
    renderer.unmount();
  });

  it('5. SteamLibraryActionBar renders 1-click quick-fix buttons for BOTTLE_STEAM_NOT_INSTALLED and BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE with inline progress + Cancel and clears error banner on completion', async () => {
    const steamGame = makeCanonicalGameFixture({
      id: 'steam-990099',
      title: 'Synthetic Bottled Action',
      steamAppId: 990099,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '990099',
          installed: true,
          installPath: '/tmp/ol-p3-ui-test/CrossOver Preview/Bottles/OneLauncher/drive_c/Games/Action',
          executablePath:
            '/tmp/ol-p3-ui-test/CrossOver Preview/Bottles/OneLauncher/drive_c/Games/Action/game.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
    });

    vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
    vi.spyOn(launcherService, 'isGameRunning').mockReturnValue(false);
    vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);
    vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);

    const launchSpy = vi.spyOn(launcherService, 'launchGame').mockResolvedValueOnce({
      success: false,
      errorCode: 'BOTTLE_STEAM_NOT_INSTALLED',
      targetBottleName: 'OneLauncher-arm64',
      chosenRunnerType: 'crossover_preview_arm64',
      installBottleName: 'OneLauncher',
      installBottleHasSteam: true,
      recommendedRunnerType: 'crossover',
      error: 'Windows Steam is not installed in bottle "OneLauncher-arm64".',
    });

    const deferredInstall = createDeferred<{
      success: boolean;
      installed: boolean;
      authenticated: boolean;
      message: string;
    }>();
    const provisionSpy = vi
      .spyOn(environmentSetupService, 'provisionAndSignInBottleSteam')
      .mockReturnValueOnce(deferredInstall.promise);
    const cancelSpy = vi
      .spyOn(environmentSetupService, 'cancelBottleSteamProvisioning')
      .mockResolvedValue(undefined);

    const renderer = createDomain12DeepRenderer(SteamLibraryActionBar, {
      game: steamGame,
      collections: [],
    });

    let tree = renderer.render();
    const playBtn = findVNodes(
      tree,
      (n) => n.type === 'button' && extractText(n).trim() === 'Play'
    )[0];
    await (playBtn.props?.onClick as () => Promise<void>)();
    tree = renderer.render();
    expect(auditModernWebAndA11y(tree)).toEqual([]);

    const quickFixBtn = findByTestId(tree, 'bottle-steam-quick-fix-btn');
    expect(quickFixBtn?.props?.type).toBe('button');
    expect(extractText(quickFixBtn)).toContain('Install & Set Up Steam in OneLauncher-arm64');
    expect(findByTestId(tree, 'bottle-steam-open-launch-config-btn')).toBeDefined();

    // Start quick fix -> inline progress + Cancel visible
    const quickFixRun = (quickFixBtn?.props?.onClick as () => Promise<void>)();
    tree = renderer.render();
    expect(auditModernWebAndA11y(tree)).toEqual([]);

    const progress = findByTestId(tree, 'bottle-steam-quick-fix-progress');
    expect(progress?.props?.role).toBe('status');
    expect(progress?.props?.['aria-live']).toBe('polite');
    const cancelBtn = findByTestId(progress, 'bottle-steam-quick-fix-cancel-btn');
    expect(cancelBtn?.props?.type).toBe('button');
    await (cancelBtn?.props?.onClick as () => Promise<void>)();
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    deferredInstall.resolve({
      success: true,
      installed: true,
      authenticated: true,
      message: 'Steam is ready in "OneLauncher-arm64".',
    });
    await quickFixRun;
    tree = renderer.render();

    expect(provisionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerType: 'crossover_preview_arm64',
        bottleName: 'OneLauncher-arm64',
        needsInstall: true,
        needsSignIn: true,
      })
    );
    expect(findByTestId(tree, 'bottle-steam-launch-error-banner')).toBeUndefined();
    expect(extractText(tree)).toContain('Steam is ready in "OneLauncher-arm64".');

    // Now test BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE -> renders Link Game into <targetBottleName>
    launchSpy.mockResolvedValueOnce({
      success: false,
      errorCode: 'BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE',
      targetBottleName: 'OneLauncher-arm64',
      chosenRunnerType: 'crossover_preview_arm64',
      error: 'Steam in bottle "OneLauncher-arm64" does not have AppID 990099 linked.',
    });
    provisionSpy.mockResolvedValueOnce({
      success: true,
      installed: true,
      authenticated: true,
      message: 'Linked installed Steam games into "OneLauncher-arm64".',
    });

    const playBtn2 = findVNodes(
      tree,
      (n) => n.type === 'button' && extractText(n).trim() === 'Play'
    )[0];
    await (playBtn2.props?.onClick as () => Promise<void>)();
    tree = renderer.render();
    expect(auditModernWebAndA11y(tree)).toEqual([]);

    const linkQuickFixBtn = findByTestId(tree, 'bottle-steam-quick-fix-btn');
    expect(linkQuickFixBtn?.props?.type).toBe('button');
    expect(extractText(linkQuickFixBtn)).toContain('Link Game into OneLauncher-arm64');

    await (linkQuickFixBtn?.props?.onClick as () => Promise<void>)();
    tree = renderer.render();

    expect(provisionSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runnerType: 'crossover_preview_arm64',
        bottleName: 'OneLauncher-arm64',
        needsInstall: false,
        needsSignIn: false,
      })
    );
    expect(findByTestId(tree, 'bottle-steam-launch-error-banner')).toBeUndefined();
    expect(extractText(tree)).toContain('Linked installed Steam games into "OneLauncher-arm64".');
    renderer.unmount();
  });
});
