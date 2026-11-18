import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { vi } from 'vitest';
import type {
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  GameLaunchConfig,
} from '../../src/contracts/launcher';
import type {
  EnvironmentComponentId,
  EnvironmentComponentState,
  EnvironmentHealthSnapshot,
  EnvironmentSetupTaskRequest,
  RunEnvironmentSetupResult,
  SetupWizardPersistedState,
} from '../../src/contracts/environmentSetup';
import type { CanonicalGame } from '../../src/contracts/game';
import type { ElectronAPI } from '../../src/types/electron';
import { installUniversalLauncherBrowserMocks, mockStorage } from '../helpers/universalLauncherHarness';
import { makeCanonicalGameFixture } from '../helpers/xboxTestHarness';
import { launcherService } from '../../src/services/launcher/launcherService';
import { environmentSetupService } from '../../src/services/launcher/environmentSetupService';

const cjsRequire = createRequire(import.meta.url);

// ============================================================================
// CJS Backend Modules (Loaded via createRequire per repo convention)
// ============================================================================

export const macNativeInstaller = cjsRequire(
  '../../electron/launcher/macNativeInstallerAndCodesign.cjs'
) as Record<string, any>;
export const environmentProvisioner = cjsRequire(
  '../../electron/launcher/environmentProvisioner.cjs'
) as Record<string, any>;
export const environmentHealthProber = cjsRequire(
  '../../electron/launcher/environmentHealthProber.cjs'
) as Record<string, any>;
export const wineAndCrossOverManager = cjsRequire(
  '../../electron/launcher/wineAndCrossOverManager.cjs'
) as Record<string, any>;
export const sessionSupervisor = cjsRequire(
  '../../electron/launcher/sessionAndProcessSupervisor.cjs'
) as Record<string, any>;
export const installedGameScanner = cjsRequire(
  '../../electron/launcher/installedGameScanner.cjs'
) as Record<string, any>;
export const steamLocalScanner = cjsRequire(
  '../../electron/storefronts/steamLocalScanner.cjs'
) as Record<string, any>;
export const launcherIpcHandlers = cjsRequire(
  '../../electron/ipc/launcherIpcHandlers.cjs'
) as Record<string, any>;
export const launcherEngine = cjsRequire('../../electron/launcherEngine.cjs') as Record<string, any>;
export const engineStateRegistry = cjsRequire(
  '../../electron/launcher/engineStateRegistry.cjs'
) as Record<string, any>;
export const diagnosticLogger = cjsRequire(
  '../../electron/utils/diagnosticLogger.cjs'
) as Record<string, any>;
export const chainedPublisherLaunchers = cjsRequire(
  '../../electron/launcher/chainedPublisherLaunchers.cjs'
) as Record<string, any>;
export const binaryAndManifestInspectors = cjsRequire(
  '../../electron/launcher/binaryAndManifestInspectors.cjs'
) as Record<string, any>;
export const securityAndPathUtils = cjsRequire(
  '../../electron/launcher/securityAndPathUtils.cjs'
) as Record<string, any>;

// ============================================================================
// Pre-M3 / Post-M3 Contract Boundary Types
// ============================================================================

export type E2ECompatibilityLayerType = CompatibilityLayerType | 'crossover_preview_arm64';
export type E2EEnvironmentComponentId = EnvironmentComponentId | 'runner_crossover_preview_arm64';
export type E2EPreviewBranch = 'standard' | 'arm64';
export type E2EBottleWineArch = 'win64' | 'arm64';

export interface E2EBottleDetail {
  wineArch?: E2EBottleWineArch;
  previewEnabled?: boolean;
  timestamp?: string;
}

export interface E2ECompatibilityLayerInfo extends Omit<CompatibilityLayerInfo, 'type'> {
  type: E2ECompatibilityLayerType;
  previewBranch?: E2EPreviewBranch;
  supportedBottleArches?: E2EBottleWineArch[];
  bottleDetails?: Record<string, E2EBottleDetail>;
}

export interface E2ECompatibilityLayerUpdateInfo
  extends Omit<CompatibilityLayerUpdateInfo, 'runnerType'> {
  runnerType: E2ECompatibilityLayerType;
  previewBranch?: E2EPreviewBranch;
  portalUrl?: string;
}

export interface E2EEnvironmentHealthSnapshot
  extends Omit<EnvironmentHealthSnapshot, 'detectedRunners' | 'components' | 'bottleSummary'> {
  detectedRunners: E2ECompatibilityLayerInfo[];
  bottleSummary: Omit<
    EnvironmentHealthSnapshot['bottleSummary'],
    'runnerType' | 'availableBottles'
  > & {
    runnerType: Exclude<E2ECompatibilityLayerType, 'native'> | null;
    availableBottles: Array<
      EnvironmentHealthSnapshot['bottleSummary']['availableBottles'][number] & {
        wineArch?: E2EBottleWineArch;
        previewEnabled?: boolean;
      }
    >;
  };
  components: Record<E2EEnvironmentComponentId, EnvironmentComponentState>;
}

export interface E2ESetupWizardPersistedState
  extends Omit<SetupWizardPersistedState, 'preferredRunnerType' | 'configuredComponents'> {
  preferredRunnerType?: Exclude<E2ECompatibilityLayerType, 'native'> | 'skip';
  configuredComponents: E2EEnvironmentComponentId[];
}

export function asContractLayerType(
  layerType: E2ECompatibilityLayerType
): Exclude<CompatibilityLayerType, 'native'> {
  return layerType as unknown as Exclude<CompatibilityLayerType, 'native'>;
}

export function asContractComponentId(
  componentId: E2EEnvironmentComponentId
): EnvironmentComponentId {
  return componentId as unknown as EnvironmentComponentId;
}

export function asContractLayerInfo(layer: E2ECompatibilityLayerInfo): CompatibilityLayerInfo {
  return layer as unknown as CompatibilityLayerInfo;
}

export function asContractSnapshot(
  snapshot: E2EEnvironmentHealthSnapshot
): EnvironmentHealthSnapshot {
  return snapshot as unknown as EnvironmentHealthSnapshot;
}

export function asContractSetupWizardState(
  state: E2ESetupWizardPersistedState
): SetupWizardPersistedState {
  return state as unknown as SetupWizardPersistedState;
}

// ============================================================================
// Synthetic PII-Safe Constants (compliant with tests/helpers/piiHygieneGuard.ts)
// ============================================================================

export const E2E_SYNTHETIC_STEAM_ID = '76561198000000042';
export const E2E_SYNTHETIC_EPIC_ACCOUNT_ID = `${'0'.repeat(30)}42`;
export const E2E_STANDARD_PREVIEW_ZIP_URL =
  'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip';
export const E2E_ARM64_PREVIEW_ZIP_URL =
  'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip';
export const E2E_STABLE_CXMAC_XML_URL = 'https://www.codeweavers.com/xml/versions/cxmac.xml';
export const E2E_PREVIEW_PORTAL_URL = 'https://www.codeweavers.com/preview/download';

// ============================================================================
// Sandbox Management
// ============================================================================

export interface E2ESandbox {
  tmpRoot: string;
  homedir: string;
  userDataDir: string;
  applicationsDir: string;
  stagingDir: string;
  downloadsDir: string;
  crossoverBottlesDir: string;
  previewBottlesDir: string;
  gamesDir: string;
  cleanup: () => void;
}

export function makeMockStatfs(
  freeBytes: number,
  totalBytes = Math.max(freeBytes * 2, 100 * 1024 * 1024 * 1024)
): () => Promise<{ bsize: number; blocks: number; bavail: number; bfree: number }> {
  const bsize = 4096;
  const bavail = Math.floor(Math.max(0, freeBytes) / bsize);
  const blocks = Math.max(bavail, Math.floor(Math.max(0, totalBytes) / bsize));
  return async () => ({
    bsize,
    blocks,
    bavail,
    bfree: bavail,
  });
}

let activeGlobalMockRestore: (() => void) | null = null;

export function resetFrontendServiceSingletons(): void {
  const ls = launcherService as any;
  for (const unsubKey of [
    'unsubscribeDownload',
    'unsubscribeSession',
    'unsubscribeHibernate',
    'unsubscribeRunnerProgress',
  ]) {
    try {
      if (typeof ls[unsubKey] === 'function') {
        ls[unsubKey]();
      }
    } catch {}
    ls[unsubKey] = undefined;
  }
  if (ls.focusListener && typeof (globalThis as any).window?.removeEventListener === 'function') {
    try {
      (globalThis as any).window.removeEventListener('focus', ls.focusListener);
    } catch {}
  }
  ls.focusListener = undefined;
  if (ls.activeDownloadPollTimer) {
    try {
      clearInterval(ls.activeDownloadPollTimer);
    } catch {}
    ls.activeDownloadPollTimer = null;
  }
  if (typeof ls.inGamePriorityScopeRelease === 'function') {
    try {
      ls.inGamePriorityScopeRelease();
    } catch {}
  }
  ls.inGamePriorityScopeRelease = null;
  ls.boundRunnerProgressApi = undefined;
  ls.initialized = false;
  ls.detectedHostArch = undefined;
  ls.compatibilityLayers = [];
  ls.installedStorefrontClients = {};
  ls.runnerUpdates = {};
  ls.launchConfigs = {};
  ls.installedRecords = [];
  ls.installedIndexMutationSeq = 0;
  ls.installedIndexBuiltSeq = -1;
  ls.installedIndexRecordsRef = null;
  ls.installedIndexRecordsLen = -1;
  ls.installedLookupIndex = {
    byPlatGameKey: new Map(),
    bySteamAppId: new Map(),
    byPlatInstallPath: new Map(),
    byPlatExePath: new Map(),
    byPlatNormTitle: new Map(),
  };
  ls.epicPlatformSupportMap = {};
  ls.activeSessions?.clear?.();
  ls.downloadQueue = [];
  ls.downloadsPausedByInGame?.clear?.();
  ls.inGameHibernating = false;
  ls.installInfoCache?.clear?.();
  ls.activeRunnerOperations?.clear?.();
  ls.runnerProgressListeners?.clear?.();
  ls.listeners?.clear?.();
  ls.inFlightScanPromise = null;
  ls.lastScanTimestamp = 0;
  ls.lastScanSucceeded = false;

  const ess = environmentSetupService as any;
  try {
    if (typeof ess.unsubscribeProgress === 'function') {
      ess.unsubscribeProgress();
    }
  } catch {}
  ess.unsubscribeProgress = null;
  ess.boundElectronApiRef = null;
  ess.lastSnapshot = null;
  ess.wizardState = null;
  ess.latestProgress = null;
  ess.progressHistory = [];
  ess.listeners?.clear?.();
  ess.inFlightProbePromise = null;
  ess.activeRunId = null;
  ess.activeGuidedLoginTarget = null;
  ess.runnerUpdateOptIn?.clear?.();
  ess.lastPreviewSignInResult = null;
  ess.runSeq = 0;
}

export function resetAllE2ESingletons(): void {
  try {
    macNativeInstaller.clearCachedAuthenticatedPreviewUrl?.();
  } catch {}
  try {
    environmentHealthProber.invalidateProberRunnerUpdatesCache?.();
  } catch {}
  try {
    engineStateRegistry.invalidateScanCaches?.();
  } catch {}
  try {
    engineStateRegistry.setUserDataDir?.(null);
  } catch {}
  try {
    sessionSupervisor.resetSupervisorStateForTests?.();
  } catch {}
  try {
    diagnosticLogger.setDiagnosticUserDataGetter?.(() => engineStateRegistry.getUserDataDir());
  } catch {}
  resetFrontendServiceSingletons();
  if (activeGlobalMockRestore) {
    try {
      activeGlobalMockRestore();
    } catch {}
    activeGlobalMockRestore = null;
  }
  mockStorage.clear();
  vi.restoreAllMocks();
}

export function createIsolatedE2ESandbox(prefix = 'ol-e2e-cxp-'): E2ESandbox {
  resetAllE2ESingletons();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homedir = path.join(tmpRoot, 'home');
  const userDataDir = path.join(tmpRoot, 'userData');
  const applicationsDir = path.join(tmpRoot, 'Applications');
  const stagingDir = path.join(tmpRoot, 'staging');
  const downloadsDir = path.join(tmpRoot, 'downloads');
  const crossoverBottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
  const previewBottlesDir = path.join(
    homedir,
    'Library/Application Support/CrossOver Preview/Bottles'
  );
  const gamesDir = path.join(tmpRoot, 'Games');

  for (const dir of [
    homedir,
    userDataDir,
    applicationsDir,
    stagingDir,
    downloadsDir,
    crossoverBottlesDir,
    previewBottlesDir,
    gamesDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  launcherEngine.setUserDataDir(userDataDir);

  return {
    tmpRoot,
    homedir,
    userDataDir,
    applicationsDir,
    stagingDir,
    downloadsDir,
    crossoverBottlesDir,
    previewBottlesDir,
    gamesDir,
    cleanup() {
      resetAllE2ESingletons();
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}

// ============================================================================
// Synthetic Bundle, Bottle & PE Binary Builders
// ============================================================================

export interface SeedBundleOptions {
  branch: 'crossover' | 'standard' | 'arm64';
  appName?: string;
  shortVersion?: string;
  bundleVersion?: string;
  suFeedUrl?: string;
  buildTimestamp?: string;
  withD3dMetal?: boolean;
  withDxmt32?: boolean;
  withDxvk32?: boolean;
}

export interface SeededAppBundle {
  appPath: string;
  cxRoot: string;
  wineBinary: string;
  wineserverBinary: string;
  wineserverArm64Binary?: string;
  wineserverX86Binary?: string;
  cxbottleBinary: string;
  infoPlistPath: string;
}

export function seedPreviewAppBundle(
  appsDir: string,
  options: SeedBundleOptions
): SeededAppBundle {
  const defaultAppName =
    options.branch === 'crossover'
      ? 'CrossOver.app'
      : options.branch === 'arm64'
        ? 'CrossOver Preview arm64.app'
        : 'CrossOver Preview.app';
  const appName = options.appName || defaultAppName;
  const shortVersion =
    options.shortVersion || (options.branch === 'crossover' ? '26.0.0' : '20261111');
  const bundleVersion =
    options.bundleVersion || (options.branch === 'crossover' ? '26.0.0.39120' : '27.0.0.41303');
  const suFeedUrl = options.suFeedUrl ?? E2E_STABLE_CXMAC_XML_URL;
  const buildTimestamp =
    options.buildTimestamp ||
    (options.branch === 'arm64'
      ? '20261111T010000Z'
      : options.branch === 'standard'
        ? '20261111T000000Z'
        : '20260115T000000Z');

  const appPath = path.join(appsDir, appName);
  const macOsDir = path.join(appPath, 'Contents/MacOS');
  const cxRoot = path.join(appPath, 'Contents/SharedSupport/CrossOver');
  const binDir = path.join(cxRoot, 'bin');
  const etcDir = path.join(cxRoot, 'etc');
  const x64UnixDir = path.join(cxRoot, 'lib/wine/x86_64-unix');

  fs.mkdirSync(macOsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(etcDir, { recursive: true });
  fs.mkdirSync(x64UnixDir, { recursive: true });

  fs.writeFileSync(path.join(macOsDir, 'CrossOver'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const wineBinary = path.join(binDir, 'wine');
  const wineserverBinary = path.join(binDir, 'wineserver');
  const cxbottleBinary = path.join(binDir, 'cxbottle');

  fs.writeFileSync(wineBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(wineserverBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(cxbottleBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(x64UnixDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  let wineserverArm64Binary: string | undefined;
  let wineserverX86Binary: string | undefined;

  if (options.branch === 'arm64') {
    const aarch64UnixDir = path.join(cxRoot, 'lib/wine/aarch64-unix');
    const aarch64WinDir = path.join(cxRoot, 'lib/wine/aarch64-windows');
    fs.mkdirSync(aarch64UnixDir, { recursive: true });
    fs.mkdirSync(aarch64WinDir, { recursive: true });
    fs.writeFileSync(path.join(aarch64UnixDir, 'ntdll.so'), 'ELF-ARM64-SYNTHETIC', 'utf8');
    fs.writeFileSync(path.join(aarch64UnixDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(aarch64WinDir, 'kernel32.dll'), 'MZ-ARM64-DLL', 'utf8');
    wineserverArm64Binary = path.join(binDir, 'wineserver-arm64');
    fs.writeFileSync(wineserverArm64Binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  } else if (options.branch === 'standard') {
    wineserverX86Binary = path.join(binDir, 'wineserver-x86');
    fs.writeFileSync(wineserverX86Binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  fs.writeFileSync(
    path.join(etcDir, 'CrossOver.conf'),
    `[CrossOver]\n"BuildTimestamp" = "${buildTimestamp}"\n`,
    'utf8'
  );

  if (options.withD3dMetal !== false) {
    const d3dResDir = path.join(cxRoot, 'lib64/external/D3DMetal.framework/Resources');
    fs.mkdirSync(d3dResDir, { recursive: true });
    fs.writeFileSync(
      path.join(d3dResDir, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>4.0b3</string>
</dict></plist>\n`,
      'utf8'
    );
  }

  if (options.withDxmt32) {
    const dxmt32Dir = path.join(cxRoot, 'lib/dxmt/i386-windows');
    fs.mkdirSync(dxmt32Dir, { recursive: true });
    fs.writeFileSync(path.join(dxmt32Dir, 'd3d11.dll'), 'DXMT32', 'utf8');
  }

  if (options.withDxvk32) {
    const dxvk32Dir = path.join(cxRoot, 'lib/dxvk/i386-windows');
    fs.mkdirSync(dxvk32Dir, { recursive: true });
    fs.writeFileSync(path.join(dxvk32Dir, 'd3d11.dll'), 'DXVK32', 'utf8');
  }

  const infoPlistPath = path.join(appPath, 'Contents/Info.plist');
  fs.writeFileSync(
    infoPlistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.codeweavers.CrossOver</string>
  <key>CFBundleName</key>
  <string>CrossOver</string>
  <key>CFBundleShortVersionString</key>
  <string>${shortVersion}</string>
  <key>CFBundleVersion</key>
  <string>${bundleVersion}</string>
  <key>SUFeedURL</key>
  <string>${suFeedUrl}</string>
</dict>
</plist>\n`,
    'utf8'
  );

  return {
    appPath,
    cxRoot,
    wineBinary,
    wineserverBinary,
    wineserverArm64Binary,
    wineserverX86Binary,
    cxbottleBinary,
    infoPlistPath,
  };
}

export interface SeedBottleOptions {
  wineArch?: E2EBottleWineArch;
  previewEnabled?: boolean;
  managedPreview?: boolean;
  timestamp?: string;
  extraConfigLines?: string[];
  sentinelMarkerFile?: string;
}

export function seedBottle(
  bottlesDir: string,
  name: string,
  options: SeedBottleOptions = {}
): string {
  const bottleDir = path.join(bottlesDir, name);
  const sys32 = path.join(bottleDir, 'drive_c/windows/system32');
  fs.mkdirSync(sys32, { recursive: true });
  fs.writeFileSync(path.join(sys32, 'kernel32.dll'), 'MZ-SYNTHETIC-DLL', 'utf8');

  const arch = options.wineArch ?? 'win64';
  const previewVal = options.previewEnabled ? '1' : '0';
  const lines = [
    ';; CrossOver Bottle Configuration',
    '[Bottle]',
    `"WineArch" = "${arch}"`,
    `"Preview" = "${previewVal}"`,
    `"Timestamp" = "${options.timestamp ?? '20261111T000000Z'}"`,
  ];
  if (options.managedPreview) {
    lines.push('"OneLauncherManagedPreview" = "1"');
  }
  if (Array.isArray(options.extraConfigLines)) {
    lines.push(...options.extraConfigLines);
  }
  fs.writeFileSync(path.join(bottleDir, 'cxbottle.conf'), `${lines.join('\n')}\n`, 'utf8');

  fs.writeFileSync(
    path.join(bottleDir, 'system.reg'),
    'WINE REGISTRY Version 2\n;; All keys relative to \\\\Machine\n\n[Software\\\\Wine]\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(bottleDir, 'user.reg'),
    'WINE REGISTRY Version 2\n;; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000\n\n[Software\\\\Wine]\n',
    'utf8'
  );

  if (options.sentinelMarkerFile) {
    const markerPath = path.join(bottleDir, 'drive_c', options.sentinelMarkerFile);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, 'PRESERVE-ME', 'utf8');
  }

  return bottleDir;
}

export function buildSyntheticPeBinary(
  machine: 0x8664 | 0xaa64 | 0x014c,
  options: { totalBytes?: number } = {}
): Buffer {
  const isPe32 = machine === 0x014c;
  const totalBytes = Math.max(4096, options.totalBytes ?? 4096);
  const buf = Buffer.alloc(totalBytes, 0);
  // MZ Header
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  const peOffset = 0x80;
  buf.writeUInt32LE(peOffset, 0x3c);

  // PE\0\0
  buf[peOffset + 0] = 0x50;
  buf[peOffset + 1] = 0x45;
  buf[peOffset + 2] = 0x00;
  buf[peOffset + 3] = 0x00;
  buf.writeUInt16LE(machine, peOffset + 4);
  buf.writeUInt16LE(1, peOffset + 6);
  buf.writeUInt16LE(isPe32 ? 224 : 240, peOffset + 20);
  buf.writeUInt16LE(0x0022, peOffset + 22);

  // OptionalHeader magic: 0x010b (PE32) or 0x020b (PE32+)
  buf.writeUInt16LE(isPe32 ? 0x010b : 0x020b, peOffset + 24);
  return buf;
}

// ============================================================================
// Offline Preview Portal Electron Mock
// ============================================================================

export interface MockPreviewPortalElectronOptions {
  authenticated?: boolean;
  simulateChallenge?: boolean;
  cancelAuth?: boolean;
  branchLinks?: string[];
  totalBytes?: number;
  archiveContent?: Buffer;
  failDownloadState?: 'interrupted' | 'cancelled';
}

export interface MockPreviewPortalElectronHarness {
  electronMod: {
    BrowserWindow: new (opts: Record<string, any>) => any;
    session: {
      fromPartition: (partition: string) => any;
    };
  };
  eventOrder: string[];
  constructorShowArgs: boolean[];
  downloadedUrls: string[];
  partitionsRequested: string[];
  get windowShownCount(): number;
  get windowDestroyed(): boolean;
}

export function createMockPreviewPortalElectron(
  options: MockPreviewPortalElectronOptions = {}
): MockPreviewPortalElectronHarness {
  let authenticated = options.authenticated !== false;
  let pendingChallenge = options.simulateChallenge === true;
  let challengeDomActive = false;
  const branchLinks = options.branchLinks ?? [
    E2E_STANDARD_PREVIEW_ZIP_URL,
    E2E_ARM64_PREVIEW_ZIP_URL,
  ];
  const eventOrder: string[] = [];
  const constructorShowArgs: boolean[] = [];
  const downloadedUrls: string[] = [];
  const partitionsRequested: string[] = [];
  let windowShownCount = 0;
  let windowDestroyed = false;

  const willDownloadListeners: Array<(evt: any, item: any, wc: any) => void> = [];

  const mockSession = {
    cookies: {
      get: vi.fn(async () =>
        authenticated
          ? [{ name: 'cw_preview_session', value: 'synthetic-session', domain: '.codeweavers.com' }]
          : []
      ),
      flushStore: vi.fn(async () => {
        eventOrder.push('flushStore');
      }),
    },
    on: vi.fn((evtName: string, fn: (evt: any, item: any, wc: any) => void) => {
      if (evtName === 'will-download') {
        eventOrder.push('register:will-download');
        willDownloadListeners.push(fn);
      }
    }),
    removeListener: vi.fn((evtName: string, fn: (evt: any, item: any, wc: any) => void) => {
      if (evtName === 'will-download') {
        const idx = willDownloadListeners.indexOf(fn);
        if (idx >= 0) willDownloadListeners.splice(idx, 1);
      }
    }),
  };

  class MockPortalBrowserWindow {
    public readonly webContents: any;
    private destroyed = false;
    private closedListeners: Array<() => void> = [];
    private currentUrl = '';

    constructor(ctorOpts: Record<string, any> = {}) {
      constructorShowArgs.push(Boolean(ctorOpts.show));
      eventOrder.push(`BrowserWindow:show=${String(Boolean(ctorOpts.show))}`);
      if (ctorOpts.show === true) {
        windowShownCount += 1;
      }

      const wcListeners = new Map<string, Array<(...args: any[]) => void>>();
      const emitWc = (evt: string, ...args: any[]) => {
        const list = (wcListeners.get(evt) || []).slice();
        for (const fn of list) fn(...args);
      };

      this.webContents = {
        setWindowOpenHandler: vi.fn(),
        getURL: () => this.currentUrl,
        on: (evt: string, fn: (...args: any[]) => void) => {
          const list = wcListeners.get(evt) || [];
          list.push(fn);
          wcListeners.set(evt, list);
        },
        removeListener: (evt: string, fn: (...args: any[]) => void) => {
          const list = wcListeners.get(evt) || [];
          wcListeners.set(
            evt,
            list.filter((f) => f !== fn)
          );
        },
        executeJavaScript: async () => {
          if (challengeDomActive) {
            return {
              hrefs: [],
              hasPasswordInput: false,
              hasChallengeDom: true,
              rawHtml: '<form id="challenge-form"></form>',
            };
          }
          if (!authenticated || this.currentUrl.includes('/login')) {
            return {
              hrefs: ['/login/forgot'],
              hasPasswordInput: true,
              hasChallengeDom: false,
            };
          }
          if (this.currentUrl.endsWith('/account')) {
            return {
              hrefs: ['/account/orders', '/preview'],
              hasPasswordInput: false,
              hasChallengeDom: false,
            };
          }
          return {
            hrefs: branchLinks,
            hasPasswordInput: false,
            hasChallengeDom: false,
          };
        },
        downloadURL: (targetUrl: string) => {
          downloadedUrls.push(targetUrl);
          eventOrder.push(`downloadURL:${targetUrl}`);
          const payload = options.archiveContent ?? Buffer.from('PK\x03\x04SYNTHETIC_ZIP', 'utf8');
          const totalBytes = options.totalBytes ?? payload.length;
          const itemListeners = new Map<string, Array<(...args: any[]) => void>>();
          let savePath = '';

          const addItemListener = (evt: string, fn: (...args: any[]) => void) => {
            const list = itemListeners.get(evt) || [];
            list.push(fn);
            itemListeners.set(evt, list);
          };

          const downloadItem = {
            getURL: () => targetUrl,
            getURLChain: () => [targetUrl],
            getFilename: () => path.basename(new URL(targetUrl).pathname),
            getTotalBytes: () => totalBytes,
            getReceivedBytes: () => totalBytes,
            setSavePath: (dest: string) => {
              savePath = dest;
            },
            cancel: () => {},
            on: addItemListener,
            once: addItemListener,
          };

          for (const listener of willDownloadListeners.slice()) {
            listener({}, downloadItem, this.webContents);
          }

          setImmediate(() => {
            if (options.failDownloadState) {
              const doneFns = itemListeners.get('done') || [];
              for (const fn of doneFns) fn({}, options.failDownloadState);
              return;
            }
            if (savePath) {
              fs.mkdirSync(path.dirname(savePath), { recursive: true });
              fs.writeFileSync(savePath, payload);
            }
            const updFns = itemListeners.get('updated') || [];
            for (const fn of updFns) fn({}, 'progressing');
            const doneFns = itemListeners.get('done') || [];
            for (const fn of doneFns) fn({}, 'completed');
          });
        },
      };

      // Expose helper for loadURL inside constructor closure
      this.loadURLImpl = async (url: string) => {
        if (options.cancelAuth) {
          this.currentUrl = 'https://www.codeweavers.com/login/';
          emitWc('did-navigate', {}, this.currentUrl);
          emitWc('did-finish-load');
          setImmediate(() => {
            this.destroy();
          });
          return;
        }
        if (pendingChallenge && url.includes('/preview/download')) {
          pendingChallenge = false;
          challengeDomActive = true;
          this.currentUrl = url;
          emitWc('did-navigate', {}, this.currentUrl);
          emitWc('did-finish-load');
          setImmediate(() => {
            challengeDomActive = false;
            authenticated = true;
            this.currentUrl = 'https://www.codeweavers.com/account';
            emitWc('did-navigate', {}, this.currentUrl);
            emitWc('did-finish-load');
          });
          return;
        }
        if (!authenticated && url.includes('/preview/download')) {
          this.currentUrl = 'https://www.codeweavers.com/login/';
          emitWc('will-redirect', {}, this.currentUrl);
          emitWc('did-navigate', {}, this.currentUrl);
          emitWc('did-finish-load');
          setImmediate(() => {
            authenticated = true;
            this.currentUrl = 'https://www.codeweavers.com/account';
            emitWc('did-navigate', {}, this.currentUrl);
            emitWc('did-finish-load');
          });
          return;
        }
        this.currentUrl = url;
        emitWc('did-navigate', {}, this.currentUrl);
        emitWc('did-finish-load');
      };
    }

    private loadURLImpl: (url: string) => Promise<void>;

    public isDestroyed() {
      return this.destroyed;
    }
    public isVisible() {
      return !this.destroyed && windowShownCount > 0;
    }
    public show() {
      windowShownCount += 1;
      eventOrder.push('show()');
    }
    public hide() {
      eventOrder.push('hide()');
    }
    public focus() {}
    public close() {
      this.destroy();
    }
    public destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      windowDestroyed = true;
      for (const fn of this.closedListeners.slice()) fn();
    }
    public on(evt: string, fn: () => void) {
      if (evt === 'closed') this.closedListeners.push(fn);
    }
    public loadURL(url: string) {
      return this.loadURLImpl(url);
    }
  }

  return {
    electronMod: {
      BrowserWindow: MockPortalBrowserWindow,
      session: {
        fromPartition: vi.fn((partition: string) => {
          partitionsRequested.push(partition);
          return mockSession;
        }),
      },
    },
    eventOrder,
    constructorShowArgs,
    downloadedUrls,
    partitionsRequested,
    get windowShownCount() {
      return windowShownCount;
    },
    get windowDestroyed() {
      return windowDestroyed;
    },
  };
}

// ============================================================================
// Opaque-Box IPC + Preload / ElectronAPI Bridge Harness
// ============================================================================

export interface IpcBridgeHarness {
  ipcHandlers: Map<string, (event: any, ...args: any[]) => Promise<any>>;
  broadcastEvents: Array<{ channel: string; payload: any }>;
  electronAPI: ElectronAPI;
  invokeChannel: (channel: string, ...args: any[]) => Promise<any>;
  emitBroadcast: (channel: string, payload: unknown) => void;
  dispose: () => void;
}

export function createIpcAndServiceHarness(options: {
  engineOverrides?: Record<string, any>;
  arch?: string;
  platform?: NodeJS.Platform;
  dialogResult?: { canceled: boolean; filePaths: string[] };
} = {}): IpcBridgeHarness {
  const g = globalThis as Record<string, any>;
  const savedGlobals: Array<{
    key: 'window' | 'localStorage' | 'CustomEvent';
    hadOwn: boolean;
    descriptor?: PropertyDescriptor;
  }> = (['window', 'localStorage', 'CustomEvent'] as const).map((key) => ({
    key,
    hadOwn: Object.prototype.hasOwnProperty.call(g, key),
    descriptor: Object.getOwnPropertyDescriptor(g, key),
  }));

  const restoreGlobals = () => {
    for (const entry of savedGlobals) {
      if (entry.hadOwn && entry.descriptor) {
        Object.defineProperty(g, entry.key, entry.descriptor);
      } else {
        delete g[entry.key];
      }
    }
  };
  activeGlobalMockRestore = restoreGlobals;

  installUniversalLauncherBrowserMocks();
  mockStorage.clear();
  resetFrontendServiceSingletons();

  const ipcHandlers = new Map<string, (event: any, ...args: any[]) => Promise<any>>();
  const broadcastEvents: Array<{ channel: string; payload: any }> = [];
  const listenersByChannel = new Map<string, Set<(...args: any[]) => void>>();

  const mockIpcMain = {
    handle(channel: string, handler: (event: any, ...args: any[]) => Promise<any>) {
      ipcHandlers.set(channel, handler);
    },
    removeHandler(channel: string) {
      ipcHandlers.delete(channel);
    },
  };

  const emitBroadcast = (channel: string, payload: any) => {
    broadcastEvents.push({ channel, payload });
    const fns = listenersByChannel.get(channel);
    if (fns) {
      for (const fn of Array.from(fns)) {
        fn(payload);
      }
    }
  };

  const mockMainWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: any) => emitBroadcast(channel, payload),
    },
  };

  const mergedEngine: Record<string, any> = {
    ...launcherEngine,
    ...(options.engineOverrides || {}),
  };

  launcherIpcHandlers.registerLauncherIpcHandlers({
    ipcMain: mockIpcMain,
    launcherEngine: mergedEngine,
    dialog: {
      showOpenDialog: vi.fn(
        async () => options.dialogResult ?? { canceled: true, filePaths: [] }
      ),
    },
    getMainWindow: () => mockMainWindow,
    options: {
      isTrustedIpcSenderFrame: () => true,
    },
  });

  const trustedEvent = {
    sender: mockMainWindow.webContents,
    senderFrame: { url: 'http://127.0.0.1:5173/' },
  };

  const invokeChannel = async (channel: string, ...args: any[]) => {
    const handler = ipcHandlers.get(channel);
    if (!handler) {
      throw new Error(`IPC channel not registered: ${channel}`);
    }
    return handler(trustedEvent, ...args);
  };

  const subscribeChannel = (channel: string, cb: (...args: any[]) => void) => {
    if (!listenersByChannel.has(channel)) {
      listenersByChannel.set(channel, new Set());
    }
    listenersByChannel.get(channel)!.add(cb);
    return () => {
      listenersByChannel.get(channel)?.delete(cb);
    };
  };

  const electronAPI: Record<string, any> = {
    platform: options.platform ?? 'darwin',
    arch: options.arch ?? 'arm64',
    getAppInfo: async () => ({
      version: '1.0.0-e2e',
      platform: options.platform ?? 'darwin',
      arch: options.arch ?? 'arm64',
      isUpdatedLaunch: false,
    }),
    detectCompatibilityLayers: (opts?: unknown) =>
      invokeChannel('launcher:detect-compat-layers', opts),
    checkCompatibilityLayerUpdates: (opts?: unknown) =>
      invokeChannel('launcher:check-compat-updates', opts),
    installCompatibilityLayer: (payload: unknown) =>
      invokeChannel('launcher:install-compat-layer', payload),
    updateCompatibilityLayer: (payload: unknown) =>
      invokeChannel('launcher:update-compat-layer', payload),
    cancelCompatibilityLayerOperation: (runnerType: unknown) =>
      invokeChannel('launcher:cancel-compat-layer-op', runnerType),
    selectRunnerArchiveDialog: (defaultPath?: string) =>
      invokeChannel('launcher:select-runner-archive', defaultPath),
    onCompatibilityRunnerProgress: (cb: (...args: any[]) => void) =>
      subscribeChannel('launcher:compat-runner-progress', cb),
    probeEnvironmentHealth: (opts?: unknown) =>
      invokeChannel('launcher:probe-environment-health', opts),
    runEnvironmentSetupTasks: (payload: unknown) =>
      invokeChannel('launcher:run-environment-setup-tasks', payload),
    cancelEnvironmentSetup: (runId?: string) =>
      invokeChannel('launcher:cancel-environment-setup', runId),
    startGuidedClientLogin: (payload: unknown) =>
      invokeChannel('launcher:start-guided-client-login', payload),
    cancelGuidedClientLogin: (targetId?: string) =>
      invokeChannel('launcher:cancel-guided-client-login', targetId),
    getSetupWizardState: () => invokeChannel('launcher:get-setup-wizard-state'),
    saveSetupWizardState: (patch: unknown) =>
      invokeChannel('launcher:save-setup-wizard-state', patch),
    onEnvironmentSetupProgress: (cb: (...args: any[]) => void) =>
      subscribeChannel('launcher:environment-setup-progress', cb),
    launchGame: (payload: unknown) => invokeChannel('launcher:launch-game', payload),
    stopGame: (payload: unknown) => invokeChannel('launcher:stop-game', payload),
    getRunningGames: () => invokeChannel('launcher:get-running-games'),
    installGame: (payload: unknown) => invokeChannel('launcher:install-game', payload),
    getGameInstallInfo: (payload: unknown, opts?: unknown) =>
      invokeChannel('launcher:get-install-info', payload, opts),
    getInstallInfo: (payload: unknown, opts?: unknown) =>
      invokeChannel('launcher:get-install-info', payload, opts),
    saveGameLaunchConfig: (config: GameLaunchConfig, opts?: unknown) =>
      invokeChannel('launcher:save-launch-config', config, opts),
    saveLaunchConfig: (config: GameLaunchConfig, opts?: unknown) =>
      invokeChannel('launcher:save-launch-config', config, opts),
    getGameLaunchConfigs: (opts?: unknown) => invokeChannel('launcher:get-launch-configs', opts),
    getLaunchConfig: (gameId: string, opts?: unknown) =>
      invokeChannel('launcher:get-launch-config', gameId, opts),
    deleteLaunchConfig: (gameId: string, opts?: unknown) =>
      invokeChannel('launcher:delete-launch-config', gameId, opts),
    scanAllInstalledGames: (opts?: unknown) => invokeChannel('launcher:scan-installed', opts),
    detectInstalledStorefrontClients: (opts?: unknown) =>
      invokeChannel('launcher:detect-storefront-clients', opts),
    getLauncherPerformanceSettings: async () => ({}),
    drainPendingSessions: async () => [],
    getDownloadQueue: async () => [],
    onDownloadUpdated: () => () => {},
    onSessionUpdated: () => () => {},
    onHibernateStateChanged: () => () => {},
    openExternalUrl: vi.fn(async () => ({ success: true })),
    showItemInFolder: vi.fn(async () => ({ success: true })),
  };

  (globalThis as any).window.electronAPI = electronAPI;

  return {
    ipcHandlers,
    broadcastEvents,
    electronAPI: electronAPI as unknown as ElectronAPI,
    invokeChannel,
    emitBroadcast,
    dispose() {
      listenersByChannel.clear();
      resetFrontendServiceSingletons();
      if ((globalThis as any).window) {
        delete (globalThis as any).window.electronAPI;
      }
      restoreGlobals();
      if (activeGlobalMockRestore === restoreGlobals) {
        activeGlobalMockRestore = null;
      }
      mockStorage.clear();
    },
  };
}

// ============================================================================
// React VNode & Synthetic Snapshot / Game Builders
// ============================================================================

export function findVNodes(root: any, predicate: (node: any) => boolean): any[] {
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

export function findVNodeByTestId(root: any, testId: string): any | undefined {
  return findVNodes(root, (n) => n.props?.['data-testid'] === testId)[0];
}

export function extractVNodeText(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractVNodeText).join('');
  if (typeof node === 'object' && node.props?.children !== undefined) {
    return extractVNodeText(node.props.children);
  }
  return '';
}

export async function flushSetImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

export function makeE2ESnapshot(overrides: {
  hostPlatform?: 'darwin' | 'win32' | 'linux';
  hostArch?: 'arm64' | 'x64';
  isAppleSiliconMac?: boolean;
  detectedRunners?: E2ECompatibilityLayerInfo[];
  availableBottles?: E2EEnvironmentHealthSnapshot['bottleSummary']['availableBottles'];
  recommendedBottleName?: string;
  recommendedBottleMode?: 'reuse_existing' | 'create_dedicated';
  runnerType?: Exclude<E2ECompatibilityLayerType, 'native'> | null;
  components?: Partial<Record<E2EEnvironmentComponentId, Partial<EnvironmentComponentState>>>;
} = {}): EnvironmentHealthSnapshot {
  const hostPlatform = overrides.hostPlatform ?? 'darwin';
  const hostArch = overrides.hostArch ?? 'arm64';
  const isAppleSiliconMac =
    overrides.isAppleSiliconMac ?? (hostPlatform === 'darwin' && hostArch === 'arm64');

  const ids: E2EEnvironmentComponentId[] = [
    'rosetta2',
    'win_vcredist',
    'win_webview2',
    'runner_crossover',
    'runner_crossover_preview',
    'runner_crossover_preview_arm64',
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

  const components = {} as Record<E2EEnvironmentComponentId, EnvironmentComponentState>;
  for (const id of ids) {
    const custom = overrides.components?.[id] || {};
    components[id] = {
      id: asContractComponentId(id),
      category: id.startsWith('runner_')
        ? 'compatibility_runner'
        : id === 'bottle_default'
          ? 'bottle'
          : 'os_prerequisite',
      scope: 'system',
      title:
        id === 'runner_crossover_preview_arm64'
          ? 'CrossOver Preview (arm64 / FEX)'
          : id === 'runner_crossover_preview'
            ? 'CrossOver Preview'
            : id,
      shortLabel: id,
      status:
        hostPlatform !== 'darwin' || (id === 'runner_crossover_preview_arm64' && !isAppleSiliconMac)
          ? 'not_applicable'
          : 'missing',
      canAutoInstall: true,
      recommendationTier: 'optional',
      recommendationBadge: 'Optional',
      defaultSelected: false,
      whyExplanation: 'Synthetic E2E setup snapshot component',
      statusDetail: 'Synthetic E2E status',
      ...custom,
    };
  }

  const detectedRunners = overrides.detectedRunners ?? [];
  const availableBottles = overrides.availableBottles ?? [];

  const snapshot: E2EEnvironmentHealthSnapshot = {
    probedAt: '2026-11-18T00:00:00.000Z',
    probeDurationMs: 12,
    hostPlatform,
    hostArch,
    isAppleSiliconMac,
    hasWriteAccessToSystemApplications: true,
    preferredMacApplicationsDir: '/Applications',
    connectedStorefronts: ['steam'],
    bundledHelpers: {
      gogdlReady: true,
      legendaryReady: true,
      xboxGdkBridgesReady: true,
      metalPreloadReady: true,
    },
    detectedRunners,
    bottleSummary: {
      runnerType: overrides.runnerType ?? null,
      runnerInstalled: detectedRunners.length > 0,
      availableBottles,
      recommendedBottleMode: overrides.recommendedBottleMode ?? 'create_dedicated',
      recommendedBottleName:
        overrides.recommendedBottleName ??
        (overrides.runnerType === 'crossover_preview_arm64' ? 'OneLauncher-arm64' : 'OneLauncher'),
    },
    components,
    clientLogins: {} as EnvironmentHealthSnapshot['clientLogins'],
    localStoreHints: [],
    counts: {
      readyCount: 0,
      missingRecommendedCount: 0,
      removedSinceLastSetupCount: 0,
      pendingClientLoginCount: 0,
      accountMismatchCount: 0,
      updateAvailableCount: 0,
    },
  };

  return asContractSnapshot(snapshot);
}

export function makeE2ECanonicalGame(overrides: Partial<CanonicalGame> = {}): CanonicalGame {
  return makeCanonicalGameFixture({
    id: 'e2e-windows-game-1',
    title: 'Synthetic Windows Game',
    platforms: [
      {
        platformId: 'steam',
        platformGameId: '220',
        installed: true,
        installPath: '/Users/test/Games/SyntheticGame',
        executablePath: '/Users/test/Games/SyntheticGame/game.exe',
        platforms: { windows: true },
        playtimeMinutes: 0,
      },
    ],
    ...overrides,
  });
}

export function makeSimpleSetupSuccessResult(
  tasks: EnvironmentSetupTaskRequest[],
  snapshot: EnvironmentHealthSnapshot
): RunEnvironmentSetupResult {
  return {
    success: true,
    runId: 'e2e-setup-run-1',
    outcomes: tasks.map((t) => ({
      componentId: t.componentId,
      action: t.action,
      status: 'completed',
      message: `Completed ${t.action}`,
    })),
    snapshot,
  };
}
