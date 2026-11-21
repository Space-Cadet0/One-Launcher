import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  type ActiveGameSession,
  type CompatibilityLayerInfo,
  type GameLaunchConfig,
  type InstalledGameRecord,
  type LauncherActionResult,
} from '../src/contracts/launcher';
import {
  extractBottleNameFromPath,
  findCompatibleRunnerForBottle,
} from '../src/services/launcher/bottleArchitectureUtils';
import {
  buildEffectiveLaunchModePreview,
  buildStorefrontLaunchPolicyView,
  computeFastMinimalLaunchAdvisory,
  type ResolveLaunchModePreviewInput,
} from '../src/services/launcher/launchPolicyPreview';
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
    if (tag === 'summary') {
      const forbiddenInsideSummary = findVNodes(
        el.props?.children,
        (child) =>
          typeof child.type === 'string' &&
          ['button', 'a', 'input', 'select', 'textarea', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(
            child.type
          )
      );
      if (forbiddenInsideSummary.length > 0) {
        violations.push(
          `summary-nested-forbidden:${forbiddenInsideSummary.map((n) => String(n.type)).join(',')}`
        );
      }
    }
  }

  for (const el of elements) {
    if (el.type === 'label') {
      const htmlFor = el.props?.htmlFor;
      if (typeof htmlFor === 'string' && htmlFor.trim() && !ids.has(htmlFor.trim())) {
        violations.push(`label-orphaned-for:${htmlFor}`);
      }
    }
  }

  return violations;
}

const memStorage = createMemoryStorage();

function installDomGlobals(): void {
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
    electronAPI: { platform: 'darwin' },
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

function makeMacLayers(): {
  previewWin64: CompatibilityLayerInfo;
  stableWin64: CompatibilityLayerInfo;
  previewArm64: CompatibilityLayerInfo;
} {
  const previewWin64: CompatibilityLayerInfo = {
    id: 'crossover_preview',
    type: 'crossover_preview',
    name: 'CrossOver Preview',
    binaryPath: '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
    appPath: '/Applications/CrossOver Preview.app',
    bottlesDir: '/tmp/ol-w5-test/CrossOver Preview/Bottles',
    availableBottles: ['OneLauncher', 'SteamAlt', 'OneLauncher-arm64'],
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
        hasGogGalaxy: true,
        hasEpicLauncher: false,
      },
      SteamAlt: {
        wineArch: 'win64',
        previewEnabled: true,
        hasSteam: true,
        steamSignedIn: false,
      },
      'OneLauncher-arm64': {
        wineArch: 'arm64',
        previewEnabled: true,
        hasSteam: false,
        steamSignedIn: false,
      },
    },
  };

  const stableWin64: CompatibilityLayerInfo = {
    id: 'crossover',
    type: 'crossover',
    name: 'CrossOver',
    binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
    appPath: '/Applications/CrossOver.app',
    bottlesDir: '/tmp/ol-w5-test/CrossOver/Bottles',
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
      },
    },
  };

  const previewArm64: CompatibilityLayerInfo = {
    id: 'crossover_preview_arm64',
    type: 'crossover_preview_arm64',
    name: 'CrossOver Preview (arm64 / FEX)',
    binaryPath: '/Applications/CrossOver Preview ARM64.app/Contents/SharedSupport/CrossOver/bin/wine',
    appPath: '/Applications/CrossOver Preview ARM64.app',
    bottlesDir: '/tmp/ol-w5-test/CrossOver Preview/Bottles',
    availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
    available: true,
    version: '26.1.0-arm64',
    hostArch: 'arm64',
    previewBranch: 'arm64',
    supportedBottleArches: ['arm64'],
    bottleDetails: {
      OneLauncher: {
        wineArch: 'win64',
        hasSteam: true,
        steamSignedIn: true,
      },
      'OneLauncher-arm64': {
        wineArch: 'arm64',
        previewEnabled: true,
        hasSteam: false,
        steamSignedIn: false,
      },
    },
  };

  return { previewWin64, stableWin64, previewArm64 };
}

describe('Phase 2 W5 — Frontend Launch Config UI, Policy Preview & ActionBar Recovery', () => {
  beforeEach(() => {
    memStorage.clear();
    installDomGlobals();
    launcherService.savePerformanceSettings({ ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Verifies strict contract extensions on CompatibilityLayerInfo.bottleDetails, ActiveGameSession.winePrefix, and LauncherActionResult', () => {
    const { previewWin64 } = makeMacLayers();
    expect(previewWin64.bottleDetails?.OneLauncher?.hasSteam).toBe(true);
    expect(previewWin64.bottleDetails?.OneLauncher?.steamSignedIn).toBe(true);
    expect(previewWin64.bottleDetails?.OneLauncher?.hasGogGalaxy).toBe(true);
    expect(previewWin64.bottleDetails?.OneLauncher?.hasEpicLauncher).toBe(false);

    const session: ActiveGameSession = {
      sessionId: 'sess-w5-1',
      gameId: 'steam-990001',
      title: 'Synthetic Arena',
      platformId: 'steam',
      platformGameId: '990001',
      startedAt: new Date().toISOString(),
      launchMethod: 'compatibility_layer',
      status: 'running',
      winePrefix: '/tmp/ol-w5-test/CrossOver Preview/Bottles/OneLauncher',
      isBottledSession: true,
    };
    expect(session.winePrefix).toContain('/Bottles/OneLauncher');

    const failRes: LauncherActionResult = {
      success: false,
      error: 'Windows Steam is not installed in bottle OneLauncher-arm64.',
      errorCode: 'BOTTLE_STEAM_NOT_INSTALLED',
      targetBottleName: 'OneLauncher-arm64',
      targetBottlePath: '/tmp/ol-w5-test/CrossOver Preview/Bottles/OneLauncher-arm64',
      installBottleName: 'OneLauncher',
      installBottleHasSteam: true,
      recommendedRunnerType: 'crossover_preview',
    };
    expect(failRes.errorCode).toBe('BOTTLE_STEAM_NOT_INSTALLED');
    expect(failRes.recommendedRunnerType).toBe('crossover_preview');
  });

  it('2. extractBottleNameFromPath and findCompatibleRunnerForBottle handle POSIX/Windows paths, arch metadata, host support, and runner priority', () => {
    expect(
      extractBottleNameFromPath(
        '/tmp/Library/Application Support/CrossOver Preview/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/Game/game.exe'
      )
    ).toBe('OneLauncher');
    expect(
      extractBottleNameFromPath('/tmp/CrossOver/Bottles/My Steam Bottle/drive_c/game.exe')
    ).toBe('My Steam Bottle');
    expect(extractBottleNameFromPath('C:\\CrossOver\\Bottles\\Win64Steam\\drive_c\\app.exe')).toBe(
      'Win64Steam'
    );
    expect(extractBottleNameFromPath('/tmp/Bottles/OneLauncher-arm64')).toBe('OneLauncher-arm64');
    expect(extractBottleNameFromPath('/Applications/NativeApp.app')).toBeNull();
    expect(extractBottleNameFromPath('/tmp/Bottles/')).toBeNull();
    expect(extractBottleNameFromPath(null)).toBeNull();
    expect(extractBottleNameFromPath(undefined)).toBeNull();

    const { previewWin64, stableWin64, previewArm64 } = makeMacLayers();
    const layers = [stableWin64, previewArm64, previewWin64];

    // Prefers stable crossover over crossover_preview for win64 when both own the bottle (matching detectCompatibilityLayers stability order)
    expect(findCompatibleRunnerForBottle('OneLauncher', layers)?.type).toBe('crossover');
    // Picks crossover_preview when a win64 bottle only exists in crossover_preview
    expect(findCompatibleRunnerForBottle('SteamAlt', layers)?.type).toBe('crossover_preview');
    // Falls back to crossover_preview when stable crossover is unavailable
    expect(
      findCompatibleRunnerForBottle('OneLauncher', [
        { ...stableWin64, available: false },
        previewWin64,
        previewArm64,
      ])?.type
    ).toBe('crossover_preview');
    // Picks crossover_preview_arm64 for arm64 bottles
    expect(findCompatibleRunnerForBottle('OneLauncher-arm64', layers)?.type).toBe(
      'crossover_preview_arm64'
    );
    // Rejects arm64 runner on Intel x64 host
    expect(
      findCompatibleRunnerForBottle('OneLauncher-arm64', layers, {
        hostPlatform: 'darwin',
        hostArch: 'x64',
      })
    ).toBeNull();
    // Honors explicit bottleDetails wineArch even when bottle name lacks -arm64 suffix
    const customFexLayer: CompatibilityLayerInfo = {
      ...previewArm64,
      availableBottles: ['CustomFex'],
      bottleDetails: { CustomFex: { wineArch: 'arm64' } },
    };
    expect(
      findCompatibleRunnerForBottle('CustomFex', [previewWin64, customFexLayer])?.type
    ).toBe('crossover_preview_arm64');
  });

  it('3. launchPolicyPreview branches Bottle Steam Standard vs Silent mode, warns truthfully when targetBottleHasSteam is false, enables Native GOG default_client, and refines chained publisher copy', () => {
    const { previewWin64, previewArm64 } = makeMacLayers();
    const bottledSteamGame = makeCanonicalGameFixture({
      id: 'steam-990020',
      title: 'Synthetic Bottled Shooter',
      steamAppId: 990020,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '990020',
          installed: true,
          installPath: '/tmp/ol-w5-test/CrossOver Preview/Bottles/OneLauncher/drive_c/Games/Shooter',
          executablePath:
            '/tmp/ol-w5-test/CrossOver Preview/Bottles/OneLauncher/drive_c/Games/Shooter/shooter.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
    });

    // 3a. default_client -> Standard Bottle Steam Client (Full Window, steam.exe -applaunch)
    const standardPreviewInput: ResolveLaunchModePreviewInput = {
      game: bottledSteamGame,
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      preferredPlatformId: 'steam',
      draftConfig: {
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher',
        storefrontClientLifecycle: 'default_client',
      },
      layers: [previewWin64],
      globalStorefrontLifecycle: 'minimal_and_close_if_started',
      targetBottleHasSteam: true,
    };
    const standardPreview = buildEffectiveLaunchModePreview(standardPreviewInput);
    expect(standardPreview.autoResolvedSummary).toContain(
      'Standard Bottle Steam Client (Full Window, steam.exe -applaunch)'
    );
    expect(standardPreview.autoResolvedSummary).not.toContain('steam.exe -silent -applaunch');
    expect(standardPreview.modeNotes.auto.dynamicDesc).toContain(
      'Standard Bottle Steam Client (Full Window, steam.exe -applaunch)'
    );
    expect(standardPreview.modeNotes.compatibility_layer.dynamicDesc).toContain(
      'Standard Bottle Steam Client (Full Window, steam.exe -applaunch)'
    );

    // 3b. minimal_and_close_if_started -> Silent Bottle Steam (steam.exe -silent -applaunch)
    const silentPreview = buildEffectiveLaunchModePreview({
      ...standardPreviewInput,
      draftConfig: {
        compatibilityLayer: 'crossover_preview',
        wineBottleName: 'OneLauncher',
        storefrontClientLifecycle: 'minimal_and_close_if_started',
      },
    });
    expect(silentPreview.autoResolvedSummary).toContain(
      'Silent Bottle Steam (steam.exe -silent -applaunch)'
    );
    expect(silentPreview.modeNotes.auto.dynamicDesc).toContain(
      'Silent Bottle Steam (steam.exe -silent -applaunch)'
    );

    // 3c. targetBottleHasSteam === false (explicit AND auto-derived from bottleDetails) warns truthfully
    const missingSteamPreview = buildEffectiveLaunchModePreview({
      game: bottledSteamGame,
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      preferredPlatformId: 'steam',
      draftConfig: {
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher-arm64',
        storefrontClientLifecycle: 'minimal_and_close_if_started',
      },
      layers: [previewArm64],
      globalStorefrontLifecycle: 'minimal_and_close_if_started',
    });
    expect(missingSteamPreview.autoResolvedSummary).toContain('Windows Steam is NOT installed');
    expect(missingSteamPreview.autoResolvedSummary).toContain('OneLauncher-arm64');
    expect(missingSteamPreview.cloudSaveSummary).toContain('Windows Steam is NOT installed');

    // Fast Direct Bypass clears the missing Steam client warning
    const fastBypassPreview = buildEffectiveLaunchModePreview({
      game: bottledSteamGame,
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      preferredPlatformId: 'steam',
      draftConfig: {
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher-arm64',
        storefrontClientLifecycle: 'fast_direct_bypass',
      },
      layers: [previewArm64],
      globalStorefrontLifecycle: 'minimal_and_close_if_started',
      targetBottleHasSteam: false,
    });
    expect(fastBypassPreview.autoResolvedSummary).toContain('Fast Direct Binary Bypass');
    expect(fastBypassPreview.autoResolvedSummary).not.toContain('Windows Steam is NOT installed');

    // 3d. Native GOG Direct includes default_client option & info box
    const nativeGogView = buildStorefrontLaunchPolicyView({
      platformId: 'gog',
      detectedBuildType: 'mac_native_app',
      activeDisplayMethod: 'direct',
      effectiveLifecycle: 'default_client',
      isInstalled: true,
      hostPlatform: 'darwin',
    });
    expect(nativeGogView.showDropdown).toBe(true);
    expect(nativeGogView.dropdownOptions.map((o) => o.value)).toContain('default_client');
    expect(nativeGogView.selectedDropdownValue).toBe('default_client');
    expect(nativeGogView.infoBox.policyKey).toBe('default_client');
    expect(nativeGogView.infoBox.headline).toContain('Standard GOG Galaxy');

    // 3e. Chained publishers (ea, ubisoft, bnet, rockstar, riot) copy accurately explains DRM + minimized flags + Silent & Auto-Close cloud-sync grace
    for (const handoff of ['ea', 'ubisoft', 'bnet', 'rockstar', 'riot'] as const) {
      const view = buildStorefrontLaunchPolicyView({
        platformId: handoff === 'riot' ? 'xbox' : 'steam',
        detectedBuildType: 'windows_native',
        activeDisplayMethod: 'direct',
        effectiveLifecycle: 'minimal_and_close_if_started',
        isInstalled: true,
        hostPlatform: 'win32',
        chainedLauncherHandoff: handoff,
      });
      const serialized = JSON.stringify(view);
      expect(serialized).toContain('Publisher DRM requires launching');
      expect(serialized).toContain('post-exit cloud-sync grace');
      expect(serialized).toContain('Silent & Auto-Close');
      expect(serialized).not.toContain('/deactivated');
      expect(serialized).not.toContain('-SuppressBrowser');
      if (handoff === 'ubisoft') {
        expect(serialized).toContain('-minimized');
      }
      if (handoff === 'rockstar') {
        expect(serialized).toContain('-minmode');
      }

      const advisory = computeFastMinimalLaunchAdvisory({
        platformId: 'xbox',
        detectedBuildType: 'windows_native',
        hostPlatform: 'win32',
        launchMethod: 'direct',
        storefrontClientLifecycle: 'minimal_and_close_if_started',
        isInstalled: true,
        chainedLauncherHandoff: handoff,
      });
      expect(advisory.warnings.join(' ')).toContain('Publisher DRM requires launching');
    }
  });

  it('4. Launch Config UI surfaces bottle Steam readiness chip, install-bottle mismatch with 1-click alignment, missing-Steam alert, global-default inheritance option, and Disclosure 3 summary policy pill (WCAG 2.2 AA)', async () => {
    const { previewWin64, stableWin64, previewArm64 } = makeMacLayers();
    const layers = [previewArm64, previewWin64, stableWin64];
    const installPath =
      '/tmp/ol-w5-test/CrossOver Preview/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/SynthQuest';
    const executablePath = `${installPath}/SynthQuest.exe`;

    const bottledGame = makeCanonicalGameFixture({
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

    vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(layers);
    vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(layers);
    vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
    vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
    vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue({
      steam: true,
      gog: true,
      epic: true,
    });
    vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue(installedRec);

    // 4a. Auto affinity (no saved runner pin) redirects away from incompatible arm64 validLayers[0] to stable crossover + OneLauncher!
    vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
    const autoRenderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
      isOpen: true,
      game: bottledGame,
      initialPlatformId: 'steam',
      onClose: vi.fn(),
    });
    autoRenderer.render();
    await Promise.resolve();
    const autoTree = autoRenderer.render();
    expect(findByTestId(autoTree, 'compat-runner-select')?.props?.value).toBe('crossover');
    expect(findByTestId(autoTree, 'compat-install-bottle-mismatch-warning')).toBeUndefined();
    expect(findByTestId(autoTree, 'compat-bottle-steam-missing-warning')).toBeUndefined();
    const readyChip = findByTestId(autoTree, 'compat-bottle-steam-readiness-chip');
    expect(readyChip?.props?.['data-steam-readiness']).toBe('ready');
    expect(extractText(readyChip)).toContain('Steam Ready');

    // Disclosure 3 summary policy pill visible on collapsed <details> with zero interactive elements inside <summary>
    const disclosure3 = findByTestId(autoTree, 'disclosure-lifecycle-overrides');
    expect(disclosure3?.type).toBe('details');
    expect(disclosure3?.props?.open).toBeUndefined();
    const policyPill = findByTestId(autoTree, 'disclosure-lifecycle-policy-pill');
    expect(policyPill?.type).toBe('span');
    expect(extractText(policyPill)).toBe('Silent & Auto-Close');
    expect(auditModernWebAndA11y(autoTree)).toEqual([]);
    autoRenderer.unmount();

    // 4a2. P0-1A: When canonical default validLayers[0] is ALREADY compatible with installBottle, preserve validLayers[0] (never hijack!)
    const previewFirstLayers = [previewWin64, stableWin64];
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(previewFirstLayers);
    vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(previewFirstLayers);
    const keepDefaultRenderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
      isOpen: true,
      game: bottledGame,
      initialPlatformId: 'steam',
      onClose: vi.fn(),
    });
    keepDefaultRenderer.render();
    await Promise.resolve();
    const keepDefaultTree = keepDefaultRenderer.render();
    expect(findByTestId(keepDefaultTree, 'compat-runner-select')?.props?.value).toBe(
      'crossover_preview'
    );
    keepDefaultRenderer.unmount();
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(layers);
    vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(layers);

    // 4b. Explicitly pinned arm64 runner (OneLauncher-arm64, hasSteam: false) -> renders BOTH banners + No Steam chip + truthful DetectedPipelineBanner
    const savedPinnedArm64: GameLaunchConfig = {
      gameId: bottledGame.id,
      preferredPlatformId: 'steam',
      launchMethod: 'compatibility_layer',
      compatibilityLayer: 'crossover_preview_arm64',
    };
    vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(savedPinnedArm64);
    const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined);

    const pinnedRenderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
      isOpen: true,
      game: bottledGame,
      initialPlatformId: 'steam',
      onClose: vi.fn(),
    });
    pinnedRenderer.render();
    await Promise.resolve();
    let tree = pinnedRenderer.render();
    expect(auditModernWebAndA11y(tree)).toEqual([]);

    const missingChip = findByTestId(tree, 'compat-bottle-steam-readiness-chip');
    expect(missingChip?.props?.['data-steam-readiness']).toBe('missing');
    expect(extractText(missingChip)).toContain('No Steam in Bottle');

    const mismatchBanner = findByTestId(tree, 'compat-install-bottle-mismatch-warning');
    expect(mismatchBanner?.props?.role).toBe('status');
    expect(mismatchBanner?.props?.['aria-live']).toBe('polite');
    expect(extractText(mismatchBanner)).toContain('OneLauncher');
    expect(extractText(mismatchBanner)).toContain('OneLauncher-arm64');

    const missingSteamAlert = findByTestId(tree, 'compat-bottle-steam-missing-warning');
    expect(missingSteamAlert?.props?.role).toBe('alert');
    expect(extractText(missingSteamAlert)).toContain('No Steam in Bottle');

    // DetectedPipelineBanner truthfully warns that Windows Steam is NOT installed
    const pinnedHtml = renderToStaticMarkup(tree as React.ReactElement);
    expect(pinnedHtml).toContain('Windows Steam is NOT installed');

    // 1-click button switches to CrossOver (OneLauncher), clearing both warnings!
    const alignBtn = findByTestId(tree, 'compat-align-install-bottle-btn');
    expect(alignBtn?.props?.type).toBe('button');
    expect(extractText(alignBtn)).toContain('Switch to CrossOver (OneLauncher)');
    (alignBtn?.props?.onClick as () => void)();
    tree = pinnedRenderer.render();

    expect(findByTestId(tree, 'compat-runner-select')?.props?.value).toBe('crossover');
    expect(findByTestId(tree, 'compat-install-bottle-mismatch-warning')).toBeUndefined();
    expect(findByTestId(tree, 'compat-bottle-steam-missing-warning')).toBeUndefined();
    expect(findByTestId(tree, 'compat-bottle-steam-readiness-chip')?.props?.['data-steam-readiness']).toBe(
      'ready'
    );

    // Switch runner to CrossOver Preview and bottle to SteamAlt (hasSteam: true, steamSignedIn: false) -> Steam Sign-In Needed chip
    const runnerSelectForPreview = findByTestId(tree, 'compat-runner-select');
    (runnerSelectForPreview?.props?.onChange as (ev: { target: { value: string } }) => void)({
      target: { value: 'crossover_preview' },
    });
    tree = pinnedRenderer.render();
    const bottleSelect = findVNodes(
      tree,
      (n) => n.type === 'select' && n.props?.id === 'compat-target-bottle-control'
    )[0];
    expect(bottleSelect).toBeDefined();
    (bottleSelect.props?.onChange as (ev: { target: { value: string } }) => void)({
      target: { value: 'SteamAlt' },
    });
    tree = pinnedRenderer.render();
    const signInChip = findByTestId(tree, 'compat-bottle-steam-readiness-chip');
    expect(signInChip?.props?.['data-steam-readiness']).toBe('sign_in_needed');
    expect(extractText(signInChip)).toContain('Steam Sign-In Needed');

    // StorefrontLifecycleSection (P1-2): <label htmlFor> linked, binds value="default" when inheriting global default,
    // allows pinning an explicit override equal to the global policy, updates Disclosure 3 pill, and selecting "default" resets to undefined on save!
    const lifecycleSelect = findByTestId(tree, 'storefront-client-lifecycle-select');
    expect(lifecycleSelect?.props?.id).toBe('storefront-client-lifecycle-select');
    expect(lifecycleSelect?.props?.value).toBe('default');
    expect(extractText(findByTestId(tree, 'storefront-lifecycle-inheritance-badge'))).toBe(
      'Using Global Default'
    );
    const lifecycleLabel = findVNodes(
      tree,
      (n) => n.type === 'label' && n.props?.htmlFor === 'storefront-client-lifecycle-select'
    )[0];
    expect(lifecycleLabel).toBeDefined();
    const defaultOption = findVNodes(
      lifecycleSelect,
      (n) => n.type === 'option' && n.props?.value === 'default'
    )[0];
    expect(defaultOption).toBeDefined();
    expect(extractText(defaultOption)).toContain('Use Global Default (Silent & Auto-Close)');

    // Pinning explicit override equal to global default ('minimal_and_close_if_started') transitions select value & badge cleanly
    (lifecycleSelect?.props?.onChange as (ev: { target: { value: string } }) => void)({
      target: { value: 'minimal_and_close_if_started' },
    });
    tree = pinnedRenderer.render();
    expect(findByTestId(tree, 'storefront-client-lifecycle-select')?.props?.value).toBe(
      'minimal_and_close_if_started'
    );
    expect(extractText(findByTestId(tree, 'storefront-lifecycle-inheritance-badge'))).toBe(
      'Per-Game Override'
    );

    (
      findByTestId(tree, 'storefront-client-lifecycle-select')?.props?.onChange as (ev: {
        target: { value: string };
      }) => void
    )({
      target: { value: 'default_client' },
    });
    tree = pinnedRenderer.render();
    expect(findByTestId(tree, 'storefront-client-lifecycle-select')?.props?.value).toBe(
      'default_client'
    );
    expect(extractText(findByTestId(tree, 'disclosure-lifecycle-policy-pill'))).toBe(
      'Standard Client'
    );

    // Revert back to Global Default ('default') -> select displays 'default', pill returns to Silent & Auto-Close and saves undefined!
    const updatedSelect = findByTestId(tree, 'storefront-client-lifecycle-select');
    (updatedSelect?.props?.onChange as (ev: { target: { value: string } }) => void)({
      target: { value: 'default' },
    });
    tree = pinnedRenderer.render();
    expect(findByTestId(tree, 'storefront-client-lifecycle-select')?.props?.value).toBe('default');
    expect(extractText(findByTestId(tree, 'storefront-lifecycle-inheritance-badge'))).toBe(
      'Using Global Default'
    );
    expect(extractText(findByTestId(tree, 'disclosure-lifecycle-policy-pill'))).toBe(
      'Silent & Auto-Close'
    );

    const saveBtn = findByTestId(tree, 'launch-config-save-btn');
    await (saveBtn?.props?.onClick as () => Promise<void>)();
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const savedArg = saveSpy.mock.calls[0]?.[0];
    expect(savedArg?.storefrontClientLifecycle).toBeUndefined();
    expect(savedArg?.platformConfigs?.steam?.storefrontClientLifecycle).toBeUndefined();
    pinnedRenderer.unmount();
  });

  it('5. SteamLibraryActionBar renders persistent inline role="alert" banner for BOTTLE_STEAM_* failures with Open Launch Config and Dismiss buttons', async () => {
    const steamGame = makeCanonicalGameFixture({
      id: 'steam-990099',
      title: 'Synthetic Bottled Action',
      steamAppId: 990099,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '990099',
          installed: true,
          installPath: '/tmp/ol-w5-test/CrossOver Preview/Bottles/OneLauncher/drive_c/Games/Action',
          executablePath:
            '/tmp/ol-w5-test/CrossOver Preview/Bottles/OneLauncher/drive_c/Games/Action/game.exe',
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
      installBottleName: 'OneLauncher',
      installBottleHasSteam: true,
      recommendedRunnerType: 'crossover_preview',
      error:
        'Cannot launch "Synthetic Bottled Action" via Steam Client: bottle "OneLauncher-arm64" does not have Windows Steam installed.',
    });

    const renderer = createDomain12DeepRenderer(SteamLibraryActionBar, {
      game: steamGame,
      collections: [],
    });

    let tree = renderer.render();
    expect(findByTestId(tree, 'bottle-steam-launch-error-banner')).toBeUndefined();

    // Trigger Play click -> launchGame returns BOTTLE_STEAM_NOT_INSTALLED
    const playBtn = findVNodes(
      tree,
      (n) => n.type === 'button' && extractText(n).trim() === 'Play'
    )[0];
    expect(playBtn).toBeDefined();
    await (playBtn.props?.onClick as () => Promise<void>)();

    tree = renderer.render();
    expect(auditModernWebAndA11y(tree)).toEqual([]);

    const banner = findByTestId(tree, 'bottle-steam-launch-error-banner');
    expect(banner).toBeDefined();
    expect(banner?.props?.role).toBe('alert');
    expect(banner?.props?.['data-error-code']).toBe('BOTTLE_STEAM_NOT_INSTALLED');
    expect(extractText(banner)).toContain('OneLauncher-arm64');

    const openConfigBtn = findByTestId(tree, 'bottle-steam-open-launch-config-btn');
    expect(openConfigBtn?.props?.type).toBe('button');
    expect(extractText(openConfigBtn)).toContain('Open Launch Config');

    const dismissBtn = findByTestId(tree, 'bottle-steam-dismiss-error-btn');
    expect(dismissBtn?.props?.type).toBe('button');
    expect(extractText(dismissBtn)).toContain('Dismiss');

    // Clicking Open Launch Config mounts the Launch Config ModalErrorBoundary (isOpen=true)
    const beforeOpenHasLazyModal = findVNodes(
      tree,
      (n) => n.props?.modalName === 'Launch Configuration'
    );
    expect(beforeOpenHasLazyModal).toHaveLength(0);
    (openConfigBtn?.props?.onClick as () => void)();
    tree = renderer.render();
    const afterOpenModalHtml = renderToStaticMarkup(tree as React.ReactElement);
    // Notice ModalErrorBoundary renders Suspense children when isLaunchConfigOpen === true
    expect(afterOpenModalHtml).toContain('data-testid="bottle-steam-launch-error-banner"');
    const suspenseNodes = findVNodes(tree, (n) => n.type === React.Suspense);
    expect(suspenseNodes.length).toBeGreaterThanOrEqual(1);
    // Dismissing hides the inline banner cleanly
    (findByTestId(tree, 'bottle-steam-dismiss-error-btn')?.props?.onClick as () => void)();
    tree = renderer.render();
    expect(findByTestId(tree, 'bottle-steam-launch-error-banner')).toBeUndefined();

    // Also handles BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE
    launchSpy.mockResolvedValueOnce({
      success: false,
      errorCode: 'BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE',
      error: 'Steam in bottle "SteamAlt" does not have AppID 990099 installed.',
    });
    const playBtn2 = findVNodes(
      tree,
      (n) => n.type === 'button' && extractText(n).trim() === 'Play'
    )[0];
    await (playBtn2.props?.onClick as () => Promise<void>)();
    tree = renderer.render();
    const manifestBanner = findByTestId(tree, 'bottle-steam-launch-error-banner');
    expect(manifestBanner?.props?.['data-error-code']).toBe(
      'BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE'
    );
    expect(extractText(manifestBanner)).toContain('AppID 990099');
    renderer.unmount();
  });
});
