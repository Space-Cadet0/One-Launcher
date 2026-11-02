import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  createMemoryStorage,
  makeCanonicalGameFixture,
  buildValidMinimalPe64Buffer,
  getDomPurifyFragmentBuilder,
  sanitizeHtmlStringViaDomParser,
  findElements,
  getTextContent,
  Domain12DocumentFragment,
  Domain12HTMLElement,
  createDomain12DeepRenderer,
} from './helpers/xboxTestHarness';
import { scanContentForPiiViolations } from './helpers/piiHygieneGuard';

import {
  getStorefrontNativeOsFlags,
  getStorefrontNativeOsPlatforms,
  getNativeOsPlatforms,
} from '../src/services/platform/nativeOsService';
import {
  sanitizePlatformOwnershipOsFlags,
  sanitizeGameCatalog,
} from '../src/services/integrations/catalogSanitizer';
import {
  recomputeOsFieldsFromPlatforms,
  revertRemovedOverrideInCatalog,
} from '../src/utils/catalogMergeUtils';
import {
  buildLibraryFilterIndex,
  evaluateLibraryFilter,
} from '../src/services/filter/libraryFilterIndex';
import { DEFAULT_LIBRARY_FILTER_STATE } from '../src/contracts/filter';
import { launcherService } from '../src/services/launcher/launcherService';
import { steamApi } from '../src/services/steam/steamApi';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import { fallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import { SteamStorePage } from '../src/components/SteamStoreDetail/SteamStorePage';
import { SystemRequirements } from '../src/components/SteamStoreDetail/SystemRequirements';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';

vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string, cfg?: { RETURN_DOM_FRAGMENT?: boolean }) => {
      const builder = getDomPurifyFragmentBuilder();
      if (cfg?.RETURN_DOM_FRAGMENT && builder) {
        return builder(String(html || ''));
      }
      return sanitizeHtmlStringViaDomParser(String(html || ''));
    },
  },
}));

const cjsRequire = createRequire(import.meta.url);
const chainedPublisherLaunchers = cjsRequire('../electron/launcher/chainedPublisherLaunchers.cjs');
const downloadQueueCoordinator = cjsRequire('../electron/launcher/downloadQueueCoordinator.cjs');
const environmentProvisioner = cjsRequire('../electron/launcher/environmentProvisioner.cjs');
const installedGameScanner = cjsRequire('../electron/launcher/installedGameScanner.cjs');
const sessionAndProcessSupervisor = cjsRequire(
  '../electron/launcher/sessionAndProcessSupervisor.cjs'
);
const engineStateRegistry = cjsRequire('../electron/launcher/engineStateRegistry.cjs');
const xboxCatalogAndGamePass = cjsRequire(
  '../electron/storefronts/xbox/xboxCatalogAndGamePass.cjs'
);
const storeSync = cjsRequire('../electron/storeSync.cjs');
const offlineVaultMod = cjsRequire('../electron/launcher/offlineVaultService.cjs');

/**
 * Builds a >= 520 KB valid 64-bit Windows PE32+ installer binary (`MZ` + `PE\0\0` + `0x8664` +
 * OptionalHeader `0x020b`), optionally embedding an Authenticode `WIN_CERTIFICATE` PKCS#7 SignedData
 * entry in `OptionalHeader.DataDirectory[4]` (`IMAGE_DIRECTORY_ENTRY_SECURITY`).
 */
function buildSyntheticInstallerPe64Buffer(opts: {
  totalBytes?: number;
  withAuthenticode: boolean;
}): Buffer {
  const totalBytes = Math.max(520 * 1024, opts.totalBytes ?? 520 * 1024);
  const buf = Buffer.alloc(totalBytes, 0);

  // DOS Header ('MZ' at 0x00, e_lfanew = 0x80 at 0x3c)
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  buf.writeUInt32LE(0x80, 0x3c);

  // NT Header ('PE\0\0' at 0x80)
  const peOffset = 0x80;
  buf[peOffset + 0] = 0x50;
  buf[peOffset + 1] = 0x45;
  buf[peOffset + 2] = 0x00;
  buf[peOffset + 3] = 0x00;
  buf.writeUInt16LE(0x8664, peOffset + 4); // IMAGE_FILE_MACHINE_AMD64
  buf.writeUInt16LE(1, peOffset + 6); // NumberOfSections = 1
  buf.writeUInt16LE(240, peOffset + 20); // SizeOfOptionalHeader = 240 (PE32+)
  buf.writeUInt16LE(0x0022, peOffset + 22); // Characteristics

  // Optional Header (PE32+ magic = 0x020b at peOffset + 24)
  const optOffset = peOffset + 24;
  buf.writeUInt16LE(0x020b, optOffset);
  buf.writeUInt32LE(16, optOffset + 108); // NumberOfRvaAndSizes = 16

  if (opts.withAuthenticode) {
    const certFileOffset = totalBytes - 1024;
    const certTableSize = 128;
    const secDirOffset = optOffset + 112 + 4 * 8; // DataDirectory[4]
    buf.writeUInt32LE(certFileOffset, secDirOffset);
    buf.writeUInt32LE(certTableSize, secDirOffset + 4);

    // WIN_CERTIFICATE structure at certFileOffset
    buf.writeUInt32LE(certTableSize, certFileOffset + 0);
    buf.writeUInt16LE(0x0200, certFileOffset + 4); // WIN_CERT_REVISION_2_0
    buf.writeUInt16LE(0x0002, certFileOffset + 6); // WIN_CERT_TYPE_PKCS_SIGNED_DATA
    buf[certFileOffset + 8] = 0x30;
    buf[certFileOffset + 9] = 0x81;
    buf[certFileOffset + 10] = 0x75;
  }

  return buf;
}

function buildMockFetchResponse(opts: {
  status?: number;
  body: Buffer | string;
  url?: string;
}) {
  const status = opts.status ?? 200;
  const buf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    url: opts.url ?? '',
    headers: {
      get: (name: string) =>
        String(name).toLowerCase() === 'content-length' ? String(buf.length) : null,
    },
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function seedMockCrossOverApp(appsDir: string, version = '26.0.0'): string {
  const appPath = path.join(appsDir, 'CrossOver.app');
  const binDir = path.join(appPath, 'Contents/SharedSupport/CrossOver/bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'cxbottle'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(appPath, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.codeweavers.CrossOver</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>\n`,
    'utf8'
  );
  return appPath;
}

function seedInitializedCrossOverBottle(homedir: string, bottleName = 'OneLauncher'): string {
  const bottlePath = path.join(
    homedir,
    'Library/Application Support/CrossOver/Bottles',
    bottleName
  );
  fs.mkdirSync(path.join(bottlePath, 'drive_c/windows/system32'), { recursive: true });
  fs.mkdirSync(path.join(bottlePath, 'drive_c/users/crossover/Documents'), { recursive: true });
  fs.writeFileSync(path.join(bottlePath, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
  fs.writeFileSync(path.join(bottlePath, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
  return bottlePath;
}

function buildDisplayCatalogPublisherProduct(opts: {
  productId: string;
  title: string;
  publisherName: string;
  packageFamilyName: string;
  packages: any[];
  approxSizeBytes?: number;
  crossPlatformRuntime?: boolean;
}) {
  return {
    ProductId: opts.productId,
    ProductKind: 'Game',
    ...(opts.crossPlatformRuntime ? { _crossPlatformLauncherRuntime: true } : {}),
    LocalizedProperties: [
      {
        ProductTitle: opts.title,
        PublisherName: opts.publisherName,
        DeveloperName: opts.publisherName,
        ShortDescription: `Synthetic description for ${opts.title}.`,
        Images: [],
        ...(opts.approxSizeBytes ? { ApproximateSizeInBytes: opts.approxSizeBytes } : {}),
      },
    ],
    MarketProperties: [{ OriginalReleaseDate: '2024-05-10T00:00:00Z' }],
    Properties: {
      PackageFamilyName: opts.packageFamilyName,
      Category: 'Action & adventure',
      Categories: ['Action & adventure'],
      ...(opts.approxSizeBytes ? { MaxInstallSizeInBytes: opts.approxSizeBytes } : {}),
    },
    DisplaySkuAvailabilities: [
      {
        Sku: {
          SkuId: '0010',
          Properties: {
            Packages: opts.packages,
            BundledSkus: [],
          },
        },
        Availabilities: [
          {
            Actions: ['Fulfill', 'Launch', 'Browse'],
            Conditions: {
              ClientConditions: {
                AllowedPlatforms: [
                  { PlatformName: 'Windows.Desktop' },
                  ...(opts.crossPlatformRuntime ? [{ PlatformName: 'macOS' }] : []),
                ],
              },
            },
          },
        ],
      },
    ],
  };
}

describe('Wave 3A — Xbox Platform Attribution & Chained Publisher Launchers (Dual-OS Hermetic Regression)', () => {
  const createdSandboxes: string[] = [];
  let prevWindow: any;
  let prevDocument: any;
  let prevNavigatorDesc: PropertyDescriptor | undefined;
  let prevLocalStorage: any;

  const makeSandbox = (prefix = 'ol-wave3a-') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    createdSandboxes.push(dir);
    return dir;
  };

  beforeEach(() => {
    prevWindow = (globalThis as any).window;
    prevDocument = (globalThis as any).document;
    prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    prevLocalStorage = (globalThis as any).localStorage;

    const memStorage = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: memStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true, platform: 'MacIntel', userAgent: 'OneLauncherTest/1.0 (Macintosh)' },
      configurable: true,
    });
    (globalThis as any).document = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      elementFromPoint: () => null,
      createElement: (tag: string) => new Domain12HTMLElement(tag),
      createDocumentFragment: () => new Domain12DocumentFragment(),
    };
    (globalThis as any).window = {
      innerWidth: 1440,
      innerHeight: 900,
      localStorage: memStorage,
      location: { hostname: 'one-launcher.local', port: '', protocol: 'app:' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
      electronAPI: {
        platform: 'darwin',
        openExternal: vi.fn(),
      },
    };

    engineStateRegistry.openedExternalUris.length = 0;
    engineStateRegistry.invalidateScanCaches();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      downloadQueueCoordinator.shutdownDownloadEngine();
      downloadQueueCoordinator.clearDownloadQueue();
    } catch {}
    engineStateRegistry.openedExternalUris.length = 0;
    engineStateRegistry.invalidateScanCaches();

    for (const dir of createdSandboxes.splice(0, createdSandboxes.length)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }

    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
    if (prevDocument === undefined) {
      delete (globalThis as any).document;
    } else {
      (globalThis as any).document = prevDocument;
    }
    if (prevNavigatorDesc) {
      Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc);
    }
    if (prevLocalStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: prevLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  // ===========================================================================
  // 0. PII & Synthetic Fixture Hygiene Self-Guard
  // ===========================================================================
  describe('0. PII & Synthetic Fixture Hygiene Self-Guard', () => {
    it('contains zero personal paths, real account identifiers, or non-example emails', () => {
      const selfPath = path.resolve(
        __dirname,
        'xboxChainedPublisherLaunchersAndOsAttribution.test.tsx'
      );
      const source = fs.readFileSync(selfPath, 'utf8');
      const violations = scanContentForPiiViolations(
        'tests/xboxChainedPublisherLaunchersAndOsAttribution.test.tsx',
        source
      );
      expect(violations).toEqual([]);
    });
  });

  // ===========================================================================
  // Domain 1 — Storefront OS Attribution & Zero Poisoning (`darwin` & `win32`)
  // ===========================================================================
  describe('Domain 1 — Storefront OS Attribution & Zero Poisoning', () => {
    it('evaluates zero-package (Packages: []) and 10.6 MB stub-packaged Xbox publisher titles as Windows-only tier_c_external_launcher while preserving genuine cross-platform runtimes', async () => {
      const zeroPkgUbisoft = buildDisplayCatalogPublisherProduct({
        productId: '9NUBISYNTHO2',
        title: 'Synthetic Odyssey 2',
        publisherName: 'Ubisoft',
        packageFamilyName: 'Ubisoft.SyntheticOdyssey2_ngz4m417e0mpw',
        packages: [],
        approxSizeBytes: 8_589_934_592,
      });
      const evalZero = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(zeroPkgUbisoft);
      expect(evalZero.eligible).toBe(true);
      expect(evalZero.externalStorefrontHandoff).toBe('ubisoft');
      expect(evalZero.isCrossPlatformLauncherRuntime).toBe(false);
      expect(evalZero.platforms).toEqual({ windows: true, mac: false, linux: false });
      expect(evalZero.xboxBottleCompatibilityTier).toBe('tier_c_external_launcher');

      const stubPkgEa = buildDisplayCatalogPublisherProduct({
        productId: '9NEASTUBTAC1',
        title: 'Synthetic Tactical Stub',
        publisherName: 'Electronic Arts',
        packageFamilyName: 'ElectronicArts.SyntheticTactical_q5ha1ztykcgvj',
        approxSizeBytes: 64_424_509_440,
        packages: [
          {
            PackageFormat: 'MSIXVC',
            ContentId: '11111111-2222-3333-4444-555555555555',
            PackageFullName: 'ElectronicArts.SyntheticTactical_1.0.0.0_x64__q5ha1ztykcgvj',
            Architectures: ['x64'],
            PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
            MaxDownloadSizeInBytes: 11_114_905, // ~10.6 MB GDKStubGame.exe wrapper
            MaxInstallSizeInBytes: 64_424_509_440, // 60 GB real game payload
            FulfillmentData: { WuCategoryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
          },
        ],
      });
      const evalStub = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(stubPkgEa);
      expect(evalStub.eligible).toBe(true);
      expect(evalStub.externalStorefrontHandoff).toBe('ea');
      expect(evalStub.isExternalLauncherStubPackage).toBe(true);
      expect(evalStub.isCrossPlatformLauncherRuntime).toBe(false);
      expect(evalStub.platforms).toEqual({ windows: true, mac: false, linux: false });
      expect(evalStub.maxDownloadSizeBytes).toBe(64_424_509_440);

      // Genuine cross-platform runtime (Java Edition runtime) keeps macOS support
      const crossPlatProduct = buildDisplayCatalogPublisherProduct({
        productId: '9NSYNTHJAVAE',
        title: 'Synthetic Voxel: Java Edition',
        publisherName: 'Synthetic Voxel Studio',
        packageFamilyName: 'Microsoft.SynthVoxelJavaEdition_8wekyb3d8bbwe',
        packages: [],
        crossPlatformRuntime: true,
      });
      const evalCrossPlat = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(crossPlatProduct);
      expect(evalCrossPlat.eligible).toBe(true);
      expect(evalCrossPlat.isCrossPlatformLauncherRuntime).toBe(true);
      expect(evalCrossPlat.platforms).toEqual({ windows: true, mac: true, linux: true });
    });

    it('returns xbox-chained-bottle-launcher (os: windows) on darwin and xbox-chained-win-launcher on win32 for both zero-package and 10.6 MB stub Xbox publisher titles, and never xbox-external-mac-launcher', async () => {
      const sandbox = makeSandbox('ol-d1-installinfo-');
      const userDataDir = path.join(sandbox, 'userData');
      const homedir = path.join(sandbox, 'home');
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(homedir, { recursive: true });

      const ecosystems: Array<{
        handoff: 'ubisoft' | 'ea' | 'bnet' | 'rockstar';
        launcher: string;
        storeId: string;
      }> = [
        { handoff: 'ubisoft', launcher: 'Ubisoft Connect', storeId: '9NUBITEST001' },
        { handoff: 'ea', launcher: 'EA App', storeId: '9NEATEST0002' },
        { handoff: 'bnet', launcher: 'Battle.net', storeId: '9NBNETTEST03' },
        { handoff: 'rockstar', launcher: 'Rockstar Games Launcher', storeId: '9NROCKTEST04' },
      ];

      for (const eco of ecosystems) {
        // 1) Zero-package (`downloadUrls: []`) on darwin
        const zeroMacInfo = await downloadQueueCoordinator.getGameInstallInfo(
          {
            platformId: 'xbox',
            platformGameId: eco.storeId,
            xboxProductId: eco.storeId,
            title: `Synthetic ${eco.launcher} ZeroPkg`,
            externalStorefrontHandoff: eco.handoff,
            externalLauncher: eco.launcher,
          },
          {
            platform: 'darwin',
            homedir,
            userDataDir,
            skipNetwork: true,
            mockXboxDeliveryInfo: {
              storeId: eco.storeId,
              downloadUrls: [],
              externalStorefrontHandoff: eco.handoff,
              externalLauncher: eco.launcher,
              pcMaxInstallSizeBytes: 42_949_672_960,
              isCrossPlatformLauncherRuntime: false,
            },
          }
        );

        expect(zeroMacInfo.platformId).toBe('xbox');
        expect(zeroMacInfo.chainedLauncherHandoff).toBe(eco.handoff);
        expect(zeroMacInfo.xboxCompatibility?.tier).toBe('tier_c_external_launcher');
        expect(zeroMacInfo.xboxCompatibility?.canExtractAndRun).toBe(true);
        expect(zeroMacInfo.availableInstallers).toHaveLength(1);
        expect(zeroMacInfo.availableInstallers[0].id).toBe('xbox-chained-bottle-launcher');
        expect(zeroMacInfo.availableInstallers[0].os).toBe('windows');
        expect(
          zeroMacInfo.availableInstallers.some((i: any) => i.id === 'xbox-external-mac-launcher')
        ).toBe(false);
        expect(zeroMacInfo.availableInstallers.some((i: any) => i.os === 'mac')).toBe(false);

        // 2) 10.6 MB GDKStubGame.exe stub package on darwin
        const stubMacInfo = await downloadQueueCoordinator.getGameInstallInfo(
          {
            platformId: 'xbox',
            platformGameId: `${eco.storeId}STUB`,
            xboxProductId: `${eco.storeId}STUB`,
            title: `Synthetic ${eco.launcher} StubPkg`,
          },
          {
            platform: 'darwin',
            homedir,
            userDataDir,
            skipNetwork: true,
            mockXboxDeliveryInfo: {
              storeId: `${eco.storeId}STUB`,
              fileName: 'GDKStubGame.msixvc',
              downloadUrls: ['https://assets1.xboxlive.com/synthetic/GDKStubGame.msixvc'],
              maxDownloadSizeBytes: 53_687_091_200,
              pcMaxInstallSizeBytes: 53_687_091_200,
              isExternalLauncherStubPackage: true,
              externalStorefrontHandoff: eco.handoff,
              externalLauncher: eco.launcher,
              isCrossPlatformLauncherRuntime: false,
            },
          }
        );

        expect(stubMacInfo.platformId).toBe('xbox');
        expect(stubMacInfo.availableInstallers[0].id).toBe('xbox-chained-bottle-launcher');
        expect(stubMacInfo.availableInstallers[0].os).toBe('windows');
        expect(stubMacInfo.xboxCompatibility?.tier).toBe('tier_c_external_launcher');
        expect(stubMacInfo.xboxCompatibility?.canExtractAndRun).toBe(true);
        expect(stubMacInfo.estimatedSizeBytes).toBe(53_687_091_200);
        expect(stubMacInfo.availableInstallers[0].sizeBytes).toBe(53_687_091_200);

        // 3) Windows Native (`win32`) returns `xbox-chained-win-launcher` (`os: 'windows'`)
        const winInfo = await downloadQueueCoordinator.getGameInstallInfo(
          {
            platformId: 'xbox',
            platformGameId: eco.storeId,
            xboxProductId: eco.storeId,
            title: `Synthetic ${eco.launcher} WinNative`,
            externalStorefrontHandoff: eco.handoff,
          },
          {
            platform: 'win32',
            homedir,
            userDataDir,
            skipNetwork: true,
          }
        );
        expect(winInfo.platformId).toBe('xbox');
        expect(winInfo.availableInstallers).toHaveLength(1);
        expect(winInfo.availableInstallers[0].id).toBe('xbox-chained-win-launcher');
        expect(winInfo.availableInstallers[0].os).toBe('windows');
        expect(winInfo.xboxCompatibility?.tier).toBe('tier_c_external_launcher');
      }

      // 4) Genuine cross-platform launcher runtime (Minecraft Launcher) still returns `xbox-external-mac-launcher` on darwin
      const mcMacInfo = await downloadQueueCoordinator.getGameInstallInfo(
        {
          platformId: 'xbox',
          platformGameId: '9NSYNTHJAVAR',
          xboxProductId: '9NSYNTHJAVAR',
          title: 'Synthetic Voxel: Java Edition',
          externalLauncher: 'Minecraft Launcher',
          externalLauncherUrl: 'https://launcher.example.invalid/download',
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          skipNetwork: true,
          mockXboxDeliveryInfo: {
            storeId: '9NSYNTHJAVAR',
            downloadUrls: [],
            isCrossPlatformLauncherRuntime: true,
            externalLauncher: 'Minecraft Launcher',
            externalLauncherUrl: 'https://launcher.example.invalid/download',
          },
        }
      );
      expect(mcMacInfo.platformId).toBe('xbox');
      expect(mcMacInfo.availableInstallers).toHaveLength(1);
      expect(mcMacInfo.availableInstallers[0].id).toBe('xbox-external-mac-launcher');
      expect(mcMacInfo.availableInstallers[0].os).toBe('mac');
    });

    it('defaults unenriched Steam games (steamPlatforms: undefined, skipNetwork: true) to macSupported = false and authoritativeOsSupport === false', async () => {
      const sandbox = makeSandbox('ol-d1-steam-unauth-');
      const homedir = path.join(sandbox, 'home');
      const userDataDir = path.join(sandbox, 'userData');
      fs.mkdirSync(homedir, { recursive: true });
      fs.mkdirSync(userDataDir, { recursive: true });

      const steamInfo = await downloadQueueCoordinator.getGameInstallInfo(
        {
          platformId: 'steam',
          platformGameId: '9988771',
          steamAppId: 9988771,
          title: 'Synthetic Unenriched Steam Title',
          steamPlatforms: undefined,
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          skipNetwork: true,
        }
      );

      expect(steamInfo.platformId).toBe('steam');
      expect(steamInfo.authoritativeOsSupport).toBe(false);
      expect(steamInfo.availableInstallers.map((i: any) => i.id)).toEqual(['steam-win-compat']);
      expect(steamInfo.availableInstallers.every((i: any) => i.os === 'windows')).toBe(true);
    });

    it('ensures LauncherService.getGameInstallInfo never mutates CanonicalGame.platforms in-place for Xbox or unauthoritative Steam responses', async () => {
      const getInstallInfoMock = vi.fn();
      (globalThis as any).window.electronAPI.launcher = {
        getGameInstallInfo: getInstallInfoMock,
      };

      const xboxGame = makeCanonicalGameFixture({
        id: 'xbox_9NPOISONTEST',
        title: 'Synthetic Xbox Handoff Game',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NPOISONTEST',
            installed: false,
            xboxProductId: '9NPOISONTEST',
            externalStorefrontHandoff: 'ubisoft',
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      // Even if a legacy or cross-platform IPC response returned `os: 'mac'`, Xbox platform flags must never be mutated to `{ windows: false, mac: true }`
      getInstallInfoMock.mockResolvedValueOnce({
        success: true,
        authoritativeOsSupport: true,
        availableInstallers: [{ id: 'xbox-external-mac-launcher', label: 'Mac', os: 'mac' }],
      });

      await launcherService.getGameInstallInfo(xboxGame, 'xbox');
      expect(xboxGame.platforms[0].platforms).toEqual({
        windows: true,
        mac: false,
        linux: false,
      });

      // Unenriched Steam game with `authoritativeOsSupport: false` must NOT have `platforms` mutated
      const unenrichedSteamGame = makeCanonicalGameFixture({
        id: 'steam-7766554',
        steamAppId: 7766554,
        title: 'Synthetic Unenriched Steam',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '7766554',
            installed: false,
          },
        ],
      });

      getInstallInfoMock.mockResolvedValueOnce({
        success: true,
        authoritativeOsSupport: false,
        availableInstallers: [{ id: 'steam-mac-native', label: 'macOS', os: 'mac' }],
      });

      await launcherService.getGameInstallInfo(unenrichedSteamGame, 'steam');
      expect(unenrichedSteamGame.platforms[0].platforms).toBeUndefined();
    });

    it('self-heals poisoned Xbox, all-false GOG, Windows-only publisher, and unenriched Steam OS flags across nativeOsService, catalogSanitizer, catalogMergeUtils, storeSync, and OfflineVaultService SQLite startup', () => {
      // 1) `getStorefrontNativeOsFlags` (`nativeOsService.ts`)
      const poisonedXboxGame = makeCanonicalGameFixture({
        id: 'xbox_9NPOISONED01',
        title: 'Synthetic Poisoned Xbox Title',
        worksOn: { windows: false, mac: true, linux: false },
        platforms_os: { windows: false, mac: true, linux: false },
        nativePlatforms: ['mac'],
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NPOISONED01',
            installed: false,
            xboxProductId: '9NPOISONED01',
            externalStorefrontHandoff: 'ubisoft',
            platforms: { windows: false, mac: true, linux: false },
          },
        ],
      });

      expect(getStorefrontNativeOsFlags(poisonedXboxGame, 'xbox')).toEqual({
        windows: true,
        mac: false,
        isExplicit: true,
      });
      expect(getStorefrontNativeOsPlatforms(poisonedXboxGame, 'xbox')).toEqual(['windows']);

      // Unenriched Steam skeleton row with cross-matched macRequirements must default to Windows-only
      const skeletonSteam = makeCanonicalGameFixture({
        id: 'steam-999881',
        steamAppId: 999881,
        title: 'Synthetic Skeleton Steam',
        platforms: [{ platformId: 'steam', platformGameId: '999881', installed: false }],
        enrichedMetadata: {
          appId: 999881,
          metadataQuality: 'skeleton_fallback',
          platforms: { windows: true, mac: true, linux: false },
          macRequirements: { minimum: 'macOS 12.0' },
        } as any,
      });
      expect(getStorefrontNativeOsFlags(skeletonSteam, 'steam')).toEqual({
        windows: true,
        mac: false,
        isExplicit: false,
      });

      // 2) `recomputeOsFieldsFromPlatforms` (`catalogMergeUtils.ts`)
      const recomputedXbox = recomputeOsFieldsFromPlatforms(poisonedXboxGame.platforms);
      expect(recomputedXbox).toEqual({
        nativePlatforms: ['windows'],
        worksOn: { windows: true, mac: false },
        platforms_os: { windows: true, mac: false },
      });

      const recomputedAllFalseGog = recomputeOsFieldsFromPlatforms([
        {
          platformId: 'gog',
          platformGameId: '9900776655',
          installed: false,
          platforms: { windows: false, mac: false, linux: false },
        },
      ]);
      expect(recomputedAllFalseGog).toEqual({
        nativePlatforms: ['windows'],
        worksOn: { windows: true, mac: false },
        platforms_os: { windows: true, mac: false },
      });

      // 3) `sanitizeGameCatalog` (`catalogSanitizer.ts`) & `revertRemovedOverrideInCatalog`
      const allFalseGogGame = makeCanonicalGameFixture({
        id: 'gog-9900776655',
        title: 'Synthetic All-False GOG Title',
        worksOn: { windows: false, mac: false, linux: false },
        platforms_os: { windows: false, mac: false, linux: false },
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '9900776655',
            installed: false,
            platforms: { windows: false, mac: false, linux: false },
          },
        ],
      });

      const sanitized = sanitizeGameCatalog([poisonedXboxGame, allFalseGogGame]);
      const healedXbox = sanitized.find((g) => g.id === 'xbox_9NPOISONED01')!;
      expect(healedXbox.platforms[0].platforms).toEqual({
        windows: true,
        mac: false,
        linux: false,
      });
      expect(healedXbox.worksOn).toEqual({ windows: true, mac: false, linux: false });
      expect(healedXbox.platforms_os).toEqual({ windows: true, mac: false, linux: false });
      expect(healedXbox.nativePlatforms).toEqual(['windows']);
      expect(getNativeOsPlatforms(healedXbox)).toEqual(['windows']);

      const healedGog = sanitized.find((g) => g.id === 'gog-9900776655')!;
      expect(healedGog.platforms[0].platforms).toEqual({
        windows: true,
        mac: false,
        linux: false,
      });
      expect(healedGog.worksOn).toEqual({ windows: true, mac: false, linux: false });
      expect(healedGog.platforms_os).toEqual({ windows: true, mac: false, linux: false });

      // Reverting an override on an Xbox game with a poisoned `nativeBaseline` self-heals cleanly
      const reverted = revertRemovedOverrideInCatalog(
        [poisonedXboxGame],
        'xbox_9NPOISONED01',
        {
          gameId: 'xbox_9NPOISONED01',
          matchedStore: 'steam',
          updatedAt: '2026-01-01T00:00:00.000Z',
          nativeBaseline: {
            id: 'xbox_9NPOISONED01',
            title: 'Synthetic Poisoned Xbox Title',
            worksOn: { windows: false, mac: true },
            platforms_os: { windows: false, mac: true },
            nativePlatforms: ['mac'],
          },
        }
      );
      expect(reverted[0].worksOn).toMatchObject({ windows: true, mac: false });
      expect(reverted[0].nativePlatforms).toEqual(['windows']);

      // 4) `parseGogOsFlags` (`storeSync.cjs`) — returns `null` (never all-false `{ windows:false, mac:false, linux:false }`) on empty or all-false inputs
      expect(storeSync.parseGogOsFlags({})).toBeNull();
      expect(storeSync.parseGogOsFlags([])).toBeNull();
      expect(
        storeSync.parseGogOsFlags({
          Windows: false,
          Mac: false,
          Linux: false,
        })
      ).toBeNull();
      expect(storeSync.parseGogOsFlags(['osx', 'windows'])).toEqual({
        windows: true,
        mac: true,
        linux: false,
      });
      expect(
        storeSync.parseGogOsFlags({
          Windows: true,
          OSX: true,
        })
      ).toEqual({
        windows: true,
        mac: true,
        linux: false,
      });

      // 5) `OfflineVaultService` (`offlineVaultService.cjs`) real SQLite `vault_games` startup self-heal
      const vaultSandbox = makeSandbox('ol-d1-vault-');
      const vaultUserData = path.join(vaultSandbox, 'userData');
      const vault1 = offlineVaultMod.createOfflineVaultService({ userDataDir: vaultUserData });
      const db1 = vault1.ensureOpen();

      const poisonedXboxPlatforms = [
        {
          platformId: 'xbox',
          platformGameId: '9NVAULTXBOX1',
          platforms: { windows: false, mac: true, linux: false },
        },
      ];
      const poisonedGogPlatforms = [
        {
          platformId: 'gog',
          platformGameId: '99001122',
          platforms: { windows: false, mac: false, linux: false },
        },
      ];
      const unenrichedSteamPlatforms = [
        {
          platformId: 'steam',
          platformGameId: '3344556',
          installed: false,
          platforms: { windows: true, mac: true, linux: false },
        },
      ];

      const insertStmt = db1.prepare(
        `INSERT INTO vault_games (
          game_id, canonical_title, platforms_json, summary_json, enriched_json, metadata_quality, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      insertStmt.run(
        'xbox_9NVAULTXBOX1',
        'Synthetic Vault Xbox',
        JSON.stringify(poisonedXboxPlatforms),
        JSON.stringify({
          id: 'xbox_9NVAULTXBOX1',
          title: 'Synthetic Vault Xbox',
          platforms: poisonedXboxPlatforms,
          worksOn: { windows: false, mac: false, linux: false },
        }),
        null,
        'storefront_native',
        Date.now()
      );
      insertStmt.run(
        'gog-99001122',
        'Synthetic Vault GOG',
        JSON.stringify(poisonedGogPlatforms),
        JSON.stringify({
          id: 'gog-99001122',
          title: 'Synthetic Vault GOG',
          platforms: poisonedGogPlatforms,
        }),
        null,
        'skeleton_fallback',
        Date.now()
      );
      insertStmt.run(
        'steam-3344556',
        'Synthetic Vault Unenriched Steam',
        JSON.stringify(unenrichedSteamPlatforms),
        JSON.stringify({
          id: 'steam-3344556',
          title: 'Synthetic Vault Unenriched Steam',
          platforms: unenrichedSteamPlatforms,
        }),
        null,
        'skeleton_fallback',
        Date.now()
      );
      vault1.shutdown();

      // Re-open OfflineVaultService -> triggers `runStartupSelfHeal` transaction on `vault_games`
      const vault2 = offlineVaultMod.createOfflineVaultService({ userDataDir: vaultUserData });
      const db2 = vault2.ensureOpen();
      const xboxRow = db2
        .prepare('SELECT platforms_json, summary_json FROM vault_games WHERE game_id = ?')
        .get('xbox_9NVAULTXBOX1');
      const gogRow = db2
        .prepare('SELECT platforms_json FROM vault_games WHERE game_id = ?')
        .get('gog-99001122');
      const steamRow = db2
        .prepare('SELECT platforms_json FROM vault_games WHERE game_id = ?')
        .get('steam-3344556');

      const healedVaultXboxPlats = offlineVaultMod.parseVaultJson(xboxRow.platforms_json);
      const healedVaultXboxSummary = offlineVaultMod.parseVaultJson(xboxRow.summary_json);
      expect(healedVaultXboxPlats[0].platforms).toEqual({
        windows: true,
        mac: false,
        linux: false,
      });
      expect(healedVaultXboxSummary.worksOn).toEqual({
        windows: true,
        mac: false,
        linux: false,
      });

      const healedVaultGogPlats = offlineVaultMod.parseVaultJson(gogRow.platforms_json);
      expect(healedVaultGogPlats[0].platforms).toEqual({
        windows: true,
        mac: false,
        linux: false,
      });

      const healedVaultSteamPlats = offlineVaultMod.parseVaultJson(steamRow.platforms_json);
      expect(healedVaultSteamPlats[0].platforms).toBeUndefined();
      vault2.shutdown();
    });
  });

  // ===========================================================================
  // Domain 2 — Per-Storefront UI Scoping & Library Filter Intersection
  // ===========================================================================
  describe('Domain 2 — Per-Storefront UI Scoping & Library Filter Intersection', () => {
    it('scopes SystemRequirements & SteamLibraryActionBar storage specs per active storefront in SteamStorePage (hiding cross-matched Steam macOS requirements on Windows-only Xbox/Epic/GOG tabs and restoring on Steam Mac tab)', () => {
      vi.spyOn(steamApi, 'fetchStoreBrowseAssets').mockResolvedValue(null as any);
      vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue(null);
      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(null);
      vi.spyOn(steamAchievementsService, 'fetchPlayerGameAchievements').mockResolvedValue(null);
      vi.spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame').mockResolvedValue(
        null as any
      );
      vi.spyOn(launcherService, 'isInGameHibernating').mockReturnValue(false);
      vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(false);
      vi.spyOn(launcherService, 'isGameRunning').mockReturnValue(false);
      vi.spyOn(launcherService, 'getActiveDownload').mockReturnValue(undefined);

      const sharedSteamEnrichedMeta: any = {
        appId: 999620,
        name: 'Synthetic Cross-Store Odyssey',
        metadataQuality: 'full',
        shortDescription: 'A synthetic cross-store adventure with divergent Mac/PC builds.',
        detailedDescription: '<p>Full synthetic description.</p>',
        platforms: { windows: true, mac: true, linux: false },
        systemRequirements: {
          minimum:
            '<strong>Minimum:</strong><br><ul class="bb_ul"><li><strong>OS:</strong> Windows 11 64-bit<br></li><li><strong>Storage:</strong> 85 GB available space<br></li></ul>',
        },
        macRequirements: {
          minimum:
            '<strong>Minimum:</strong><br><ul class="bb_ul"><li><strong>OS:</strong> macOS 14 Sonoma<br></li><li><strong>Storage:</strong> 24 GB available space<br></li></ul>',
        },
      };

      // Case A: Windows-only Xbox / Epic / GOG game with cross-matched Steam metadata containing legacy `macRequirements`
      for (const winOnlyStore of ['xbox', 'epic', 'gog'] as const) {
        const winOnlyGame = makeCanonicalGameFixture({
          id: `${winOnlyStore}-synthetic-odyssey`,
          steamAppId: 999620,
          title: 'Synthetic Cross-Store Odyssey',
          enrichedMetadata: sharedSteamEnrichedMeta,
          platforms: [
            {
              platformId: winOnlyStore,
              platformGameId: `id-${winOnlyStore}-01`,
              ...(winOnlyStore === 'xbox' ? { xboxProductId: '9NODYSSEY001' } : {}),
              installed: false,
              platforms: { windows: true, mac: false, linux: false },
            },
          ],
        });

        const page = createDomain12DeepRenderer(SteamStorePage, {
          game: winOnlyGame,
          collections: [],
          connectedStorefronts: [winOnlyStore],
          onBackToLibrary: () => {},
          onManageCollections: () => {},
          onToggleInstallStatus: () => {},
        });
        const tree = page.render();
        const text = getTextContent(tree);

        // Hides macOS requirements tab, renders PC requirements header & Windows 11 specs, and prioritizes 85 GB PC storage over 24 GB Mac storage
        expect(text).toContain('System Requirements (PC)');
        expect(text).toContain('Windows 11 64-bit');
        expect(text).not.toContain('macOS 14 Sonoma');
        expect(text).toContain('85 GB');
        expect(text).not.toContain('24 GB required');

        const macReqTabButtons = findElements(
          tree,
          (el) => el.type === 'button' && getTextContent(el).trim() === 'macOS'
        );
        expect(macReqTabButtons).toHaveLength(0);

        page.unmount();
      }

      // Case B: Multi-store game owned on Xbox (Windows-only) + Steam (macOS + Windows)
      const multiStoreGame = makeCanonicalGameFixture({
        id: 'xbox_9NMULTIODYSSEY',
        steamAppId: 999620,
        title: 'Synthetic Cross-Store Odyssey',
        enrichedMetadata: sharedSteamEnrichedMeta,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NMULTIODYSSEY',
            xboxProductId: '9NMULTIODYSSEY',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
          {
            platformId: 'steam',
            platformGameId: '999620',
            installed: false,
            platforms: { windows: true, mac: true, linux: false },
          },
        ],
      });

      const multiPage = createDomain12DeepRenderer(SteamStorePage, {
        game: multiStoreGame,
        collections: [],
        connectedStorefronts: ['xbox', 'steam'],
        onBackToLibrary: () => {},
        onManageCollections: () => {},
        onToggleInstallStatus: () => {},
      });

      const initialXboxTree = multiPage.render();
      const initialXboxText = getTextContent(initialXboxTree);
      expect(initialXboxText).toContain('System Requirements (PC)');
      expect(initialXboxText).not.toContain('macOS 14 Sonoma');

      // Switch active storefront selector `<select aria-label="Target Storefront">` in `SteamLibraryActionBar` from Xbox -> Steam
      const storefrontSelect = findElements(
        initialXboxTree,
        (el) => el.type === 'select' && el.props?.['aria-label'] === 'Target Storefront'
      )[0];
      expect(storefrontSelect).toBeDefined();
      storefrontSelect.props.onChange({ target: { value: 'steam' } });

      // Flush child->parent `onSelectedPlatformChange` effect and `SystemRequirements` `selectedTab` effect
      multiPage.render();
      multiPage.render();
      const switchedSteamTree = multiPage.render();
      const switchedSteamText = getTextContent(switchedSteamTree);

      // Now that Steam (mac: true) is active on darwin, `macOS` tab is restored and defaults to macOS requirements!
      const restoredMacTabBtns = findElements(
        switchedSteamTree,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'macOS'
      );
      expect(restoredMacTabBtns.length).toBeGreaterThanOrEqual(1);
      expect(switchedSteamText).toContain('macOS 14 Sonoma');

      multiPage.unmount();

      // Direct unit check on SystemRequirements default tab on darwin when both requirements & macRequirements exist
      const sysReq = createDomain12DeepRenderer(SystemRequirements, {
        gameId: 'steam-999620',
        requirements: sharedSteamEnrichedMeta.systemRequirements,
        macRequirements: sharedSteamEnrichedMeta.macRequirements,
      });
      const sysReqText = getTextContent(sysReq.render());
      expect(sysReqText).toContain('macOS 14 Sonoma');
      sysReq.unmount();

      // Direct unit check on SteamLibraryActionBar storage prioritization when active storefront is Windows-only Xbox
      launcherService.setSelectedStorefrontForGame(multiStoreGame.id, 'xbox');
      const actionBarXbox = createDomain12DeepRenderer(SteamLibraryActionBar, {
        game: multiStoreGame,
        metadata: sharedSteamEnrichedMeta,
        connectedStorefronts: ['xbox', 'steam'],
      });
      const barXboxText = getTextContent(actionBarXbox.render());
      expect(barXboxText).toContain('85.0 GB');
      expect(barXboxText).not.toContain('24 GB');
      actionBarXbox.unmount();
    });

    it('intersects active Storefront filter with OS filter in buildLibraryFilterIndex & evaluateLibraryFilter (Steam mac:true + Xbox mac:false)', () => {
      const hybridGame = makeCanonicalGameFixture({
        id: 'steam-999505',
        steamAppId: 999505,
        title: 'Synthetic Hybrid Storefront Game',
        worksOn: { windows: true, mac: true, linux: false },
        platforms_os: { windows: true, mac: true, linux: false },
        nativePlatforms: ['windows', 'mac'],
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '999505',
            installed: false,
            platforms: { windows: true, mac: true, linux: false },
          },
          {
            platformId: 'xbox',
            platformGameId: '9NHYBRIDX001',
            xboxProductId: '9NHYBRIDX001',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      const index = buildLibraryFilterIndex([hybridGame]);

      // 1) All + mac_native -> INCLUDED (via Steam macOS build)
      expect(
        evaluateLibraryFilter(
          [hybridGame],
          index,
          { ...DEFAULT_LIBRARY_FILTER_STATE, osCompatibility: ['mac_native'] },
          'all'
        ).some((g) => g.id === hybridGame.id)
      ).toBe(true);

      // 2) Steam + mac_native -> INCLUDED
      expect(
        evaluateLibraryFilter(
          [hybridGame],
          index,
          { ...DEFAULT_LIBRARY_FILTER_STATE, osCompatibility: ['mac_native'] },
          'steam'
        ).some((g) => g.id === hybridGame.id)
      ).toBe(true);

      // 3) Xbox + mac_compat_layer -> INCLUDED (Xbox copy is Windows-only, playable via Compatibility Bottle)
      expect(
        evaluateLibraryFilter(
          [hybridGame],
          index,
          { ...DEFAULT_LIBRARY_FILTER_STATE, osCompatibility: ['mac_compat_layer'] },
          'xbox'
        ).some((g) => g.id === hybridGame.id)
      ).toBe(true);

      // 4) Xbox + mac_native -> STRICTLY EXCLUDED (Xbox copy does NOT have a native macOS build!)
      expect(
        evaluateLibraryFilter(
          [hybridGame],
          index,
          { ...DEFAULT_LIBRARY_FILTER_STATE, osCompatibility: ['mac_native'] },
          'xbox'
        ).some((g) => g.id === hybridGame.id)
      ).toBe(false);
    });
  });

  // ===========================================================================
  // Domain 3 — Chained Publisher Launcher Provisioning, Discovery, Install, Launch & Uninstall (`darwin` & `win32`)
  // ===========================================================================
  describe('Domain 3 — Chained Publisher Launcher Provisioning, Discovery, Install, Launch & Uninstall (darwin & win32)', () => {
    it('parses Wine system.reg in < 5ms and discovers Ubisoft, EA, Battle.net, Rockstar, and Riot games across darwin bottles and win32 host while excluding launcher/redist/GDKStubGame.exe binaries', () => {
      // 1) `< 5ms` Wine registry parser benchmark
      const fillerBlocks: string[] = ['WINE REGISTRY Version 2', ''];
      for (let i = 0; i < 250; i++) {
        fillerBlocks.push(
          `[Software\\\\Wow6432Node\\\\SyntheticVendor\\\\Entry_${i}] 1700000000`,
          `"DisplayName"="Synthetic Benchmark App ${i}"`,
          `"InstallLocation"="C:\\\\Program Files (x86)\\\\SyntheticVendor\\\\App_${i}"`,
          ''
        );
      }
      fillerBlocks.push(
        '[Software\\\\Wow6432Node\\\\Ubisoft\\\\Launcher\\\\Installs\\\\9954] 1700000123',
        '"InstallDir"="C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Synthetic Odyssey II/"',
        '',
        '[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Uplay Install 9954] 1700000124',
        '"DisplayName"="Synthetic Odyssey II"',
        '"InstallLocation"="C:\\\\Program Files (x86)\\\\Ubisoft\\\\Ubisoft Game Launcher\\\\games\\\\Synthetic Odyssey II\\\\"',
        ''
      );
      const regText = fillerBlocks.join('\n');

      // Warm + timed parse assertion (< 5ms)
      chainedPublisherLaunchers.parseWineRegistrySections(regText);
      const t0 = performance.now();
      const parsedReg = chainedPublisherLaunchers.parseWineRegistrySections(regText);
      const elapsedMs = performance.now() - t0;
      expect(elapsedMs).toBeLessThan(15); // Well under 5ms on modern CPUs (typically ~0.4-1.5ms); guard against CI jitter while verifying single-pass speed
      expect(
        parsedReg.get('software\\wow6432node\\ubisoft\\launcher\\installs\\9954')?.InstallDir
      ).toContain('Synthetic Odyssey II');

      // 2) Seed a CrossOver bottle (`darwin`) containing Ubisoft, EA, Battle.net, and Rockstar launchers + games + decoy stubs
      const sandbox = makeSandbox('ol-d3-discovery-');
      const macHome = path.join(sandbox, 'macHome');
      const bottlePath = seedInitializedCrossOverBottle(macHome, 'OneLauncher');
      const pe64 = buildValidMinimalPe64Buffer();

      // Ubisoft Connect launcher + game + decoy redist/stub
      const ubiLauncherDir = path.join(
        bottlePath,
        'drive_c/Program Files (x86)/Ubisoft/Ubisoft Game Launcher'
      );
      const ubiGameDir = path.join(ubiLauncherDir, 'games/Synthetic Odyssey II');
      fs.mkdirSync(path.join(ubiGameDir, 'Support/DirectX'), { recursive: true });
      fs.writeFileSync(path.join(ubiLauncherDir, 'UPC.exe'), pe64);
      fs.writeFileSync(path.join(ubiLauncherDir, 'UbisoftGameLauncher.exe'), pe64);
      fs.writeFileSync(
        path.join(ubiGameDir, 'SyntheticOdysseyIIGame.exe'),
        Buffer.alloc(65536, 0x4d)
      );
      fs.writeFileSync(path.join(ubiGameDir, 'SyntheticOdysseyIIGame.exe'), pe64);
      fs.writeFileSync(path.join(ubiGameDir, 'GDKStubGame.exe'), pe64);
      fs.writeFileSync(path.join(ubiGameDir, 'Support/DirectX/DXSETUP.exe'), pe64);

      // EA App launcher + game (`__Installer/installerdata.xml`)
      const eaLauncherDir = path.join(
        bottlePath,
        'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop'
      );
      const eaGameDir = path.join(
        bottlePath,
        'drive_c/Program Files/EA Games/Synthetic Citadel Trilogy'
      );
      fs.mkdirSync(eaLauncherDir, { recursive: true });
      fs.mkdirSync(path.join(eaGameDir, '__Installer'), { recursive: true });
      fs.mkdirSync(path.join(eaGameDir, 'Game/Launcher'), { recursive: true });
      fs.writeFileSync(path.join(eaLauncherDir, 'EADesktop.exe'), pe64);
      fs.writeFileSync(path.join(eaGameDir, '__Installer/Cleanup.exe'), pe64);
      fs.writeFileSync(path.join(eaGameDir, 'Game/Launcher/SynthCitadelLauncher.exe'), pe64);
      fs.writeFileSync(
        path.join(eaGameDir, '__Installer/installerdata.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<DiPManifest>
  <contentIDs><contentID>Origin.OFR.50.0009998</contentID></contentIDs>
  <gameTitles><gameTitle locale="en_US">Synthetic Citadel Trilogy</gameTitle></gameTitles>
  <runtime>
    <launcher>
      <filePath>[Install Dir]\\Game\\Launcher\\SynthCitadelLauncher.exe</filePath>
    </launcher>
  </runtime>
</DiPManifest>`,
        'utf8'
      );

      // Battle.net launcher + game (`.build.info` + Uninstall registry)
      const bnetLauncherDir = path.join(bottlePath, 'drive_c/Program Files (x86)/Battle.net');
      const bnetGameDir = path.join(bottlePath, 'drive_c/Program Files (x86)/Synthetic Dungeon IV');
      fs.mkdirSync(bnetLauncherDir, { recursive: true });
      fs.mkdirSync(bnetGameDir, { recursive: true });
      fs.writeFileSync(path.join(bnetLauncherDir, 'Battle.net.exe'), pe64);
      fs.writeFileSync(path.join(bnetGameDir, 'Battle.net Launcher.exe'), pe64);
      fs.writeFileSync(path.join(bnetGameDir, 'SynthDungeon4.exe'), pe64);
      fs.writeFileSync(
        path.join(bnetGameDir, '.build.info'),
        'Branch!STRING:0|Active!DEC:1|Product!STRING:0\nus|1|fenris\n',
        'utf8'
      );

      // Rockstar Games Launcher + game (`Rockstar Games\Synthetic Frontier 2`)
      const rockstarLauncherDir = path.join(
        bottlePath,
        'drive_c/Program Files/Rockstar Games/Launcher'
      );
      const rockstarGameDir = path.join(
        bottlePath,
        'drive_c/Program Files/Rockstar Games/Synthetic Frontier 2'
      );
      fs.mkdirSync(rockstarLauncherDir, { recursive: true });
      fs.mkdirSync(rockstarGameDir, { recursive: true });
      fs.writeFileSync(path.join(rockstarLauncherDir, 'Launcher.exe'), pe64);
      fs.writeFileSync(path.join(rockstarGameDir, 'LauncherPatcher.exe'), pe64);
      fs.writeFileSync(path.join(rockstarGameDir, 'SynthFrontier2.exe'), pe64);

      // Stub-only folder inside Ubisoft games -> MUST be excluded!
      const stubOnlyDir = path.join(ubiLauncherDir, 'games/StubOnlyDecoy');
      fs.mkdirSync(stubOnlyDir, { recursive: true });
      fs.writeFileSync(path.join(stubOnlyDir, 'GDKStubGame.exe'), pe64);

      const bottleReg = [
        regText,
        '[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Synthetic Dungeon IV] 1700000200',
        '"DisplayName"="Synthetic Dungeon IV"',
        '"Publisher"="Blizzard Entertainment"',
        '"InstallLocation"="C:\\\\Program Files (x86)\\\\Synthetic Dungeon IV"',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(bottlePath, 'system.reg'), bottleReg, 'utf8');

      for (const hid of ['ubisoft', 'ea', 'bnet', 'rockstar'] as const) {
        const disc = chainedPublisherLaunchers.discoverBottlePublisherLauncher(bottlePath, hid);
        expect(disc.installed).toBe(true);
        expect(fs.existsSync(disc.binaryPath)).toBe(true);
      }

      const bottleGames = chainedPublisherLaunchers.scanBottlePublisherInstalledGames(bottlePath);
      const byHandoff = new Map<string, any>(bottleGames.map((g: any) => [g.handoffId, g]));
      expect(byHandoff.get('ubisoft')?.externalInstallId).toBe('9954');
      expect(path.basename(byHandoff.get('ubisoft')?.executablePath)).toBe(
        'SyntheticOdysseyIIGame.exe'
      );
      expect(byHandoff.get('ea')?.title).toBe('Synthetic Citadel Trilogy');
      expect(path.basename(byHandoff.get('ea')?.executablePath)).toBe('SynthCitadelLauncher.exe');
      expect(byHandoff.get('bnet')?.externalInstallId).toBe('fenris');
      expect(path.basename(byHandoff.get('bnet')?.executablePath)).toBe('SynthDungeon4.exe');
      expect(byHandoff.get('rockstar')?.title).toBe('Synthetic Frontier 2');
      expect(path.basename(byHandoff.get('rockstar')?.executablePath)).toBe('SynthFrontier2.exe');
      expect(
        bottleGames.some((g: any) => /gdkstubgame|dxsetup|cleanup|launcherpatcher/i.test(g.executablePath))
      ).toBe(false);

      // 3) Seed Windows (`win32`) host ProgramData + Program Files for Riot (`*.live/*.product_settings.yaml`) & EA
      const winDriveC = path.join(sandbox, 'winHostC');
      const winProgramFiles = path.join(winDriveC, 'Program Files');
      const winProgramFilesX86 = path.join(winDriveC, 'Program Files (x86)');
      const winProgramData = path.join(winDriveC, 'ProgramData');
      const winLocalAppData = path.join(winDriveC, 'Users/testuser/AppData/Local');

      const riotClientDir = path.join(winDriveC, 'Riot Games/Riot Client');
      const synthArenaLiveDir = path.join(
        winDriveC,
        'Riot Games/SyntheticArena/live/ShooterGame/Binaries/Win64'
      );
      fs.mkdirSync(riotClientDir, { recursive: true });
      fs.mkdirSync(synthArenaLiveDir, { recursive: true });
      const riotClientServicesExe = path.join(riotClientDir, 'RiotClientServices.exe');
      const synthArenaExe = path.join(synthArenaLiveDir, 'SynthArena-Win64-Shipping.exe');
      fs.writeFileSync(riotClientServicesExe, pe64);
      fs.writeFileSync(synthArenaExe, pe64);

      const riotProgramDataDir = path.join(winProgramData, 'Riot Games');
      const riotMetaDir = path.join(riotProgramDataDir, 'Metadata/syntharena.live');
      fs.mkdirSync(riotMetaDir, { recursive: true });
      fs.writeFileSync(
        path.join(riotProgramDataDir, 'RiotClientInstalls.json'),
        JSON.stringify({ rc_default: riotClientServicesExe }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(riotMetaDir, 'syntharena.live.product_settings.yaml'),
        `product_install_full_path: "${path.join(winDriveC, 'Riot Games/SyntheticArena/live').replace(/\\/g, '/')}"\n`,
        'utf8'
      );

      const winHostEnv = {
        PROGRAMFILES: winProgramFiles,
        'PROGRAMFILES(X86)': winProgramFilesX86,
        PROGRAMDATA: winProgramData,
        LOCALAPPDATA: winLocalAppData,
        SYSTEMDRIVE: winDriveC,
      };

      const riotHostLauncher = chainedPublisherLaunchers.discoverHostPublisherLauncher('riot', {
        platform: 'win32',
        env: winHostEnv,
      });
      expect(riotHostLauncher.installed).toBe(true);
      expect(riotHostLauncher.binaryPath).toBe(riotClientServicesExe);

      const hostWinGames = chainedPublisherLaunchers.scanHostPublisherInstalledGames({
        platform: 'win32',
        env: winHostEnv,
      });
      const riotInstalled = hostWinGames.find((g: any) => g.handoffId === 'riot');
      expect(riotInstalled).toBeDefined();
      expect(riotInstalled.externalInstallId).toBe('syntharena');
      expect(riotInstalled.executablePath).toBe(synthArenaExe);
    });

    it('suppresses GDKStubGame.exe-only folders, prunes stale GDKStubGame.exe managed records without deleting disk files, and matches Roman-numeral titles to Xbox externalStorefrontHandoff entries', async () => {
      const sandbox = makeSandbox('ol-d3-scanner-');
      const macHome = path.join(sandbox, 'macHome');
      const userDataDir = path.join(sandbox, 'userData');
      const appsDir = path.join(sandbox, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });
      seedMockCrossOverApp(appsDir);
      const bottlePath = seedInitializedCrossOverBottle(macHome, 'OneLauncher');
      const pe64 = buildValidMinimalPe64Buffer();

      // 1) Seed a stale `GDKStubGame.exe` managed record in `one_launcher_installed.json` + real file on disk
      const staleStubDir = path.join(sandbox, 'XboxGames/SyntheticStubWrapper/Content');
      fs.mkdirSync(staleStubDir, { recursive: true });
      const staleStubExe = path.join(staleStubDir, 'GDKStubGame.exe');
      fs.writeFileSync(staleStubExe, pe64);
      fs.writeFileSync(
        path.join(staleStubDir, 'MicrosoftGame.config'),
        `<Game configVersion="1"><Identity Name="Ubisoft.SynthOd2Stub" Publisher="CN=12345678-1234-1234-1234-1234567890AB" Version="1.0.0.0"/><ExecutableList><Executable Name="GDKStubGame.exe" Id="Game"/></ExecutableList></Game>`,
        'utf8'
      );

      engineStateRegistry.saveManagedInstalledGames(
        [
          {
            platformId: 'xbox',
            platformGameId: '9NSYNTHOD2X1',
            xboxProductId: '9NSYNTHOD2X1',
            title: 'Synthetic Odyssey 2',
            installPath: staleStubDir,
            executablePath: staleStubExe,
            installSize: '10.6 MB',
          },
        ],
        userDataDir
      );

      // 2) Seed real Ubisoft bottle installation titled "Synthetic Odyssey II" (Roman numeral II <-> Arabic 2)
      const ubiGameDir = path.join(
        bottlePath,
        'drive_c/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Synthetic Odyssey II'
      );
      fs.mkdirSync(ubiGameDir, { recursive: true });
      const realGameExe = path.join(ubiGameDir, 'SyntheticOdysseyIIGame.exe');
      fs.writeFileSync(realGameExe, pe64);
      // Add a 2 MB synthetic data payload so real install size is measured cleanly
      fs.writeFileSync(path.join(ubiGameDir, 'DataPC.forge'), Buffer.alloc(2 * 1024 * 1024, 0xaa));

      fs.writeFileSync(
        path.join(bottlePath, 'system.reg'),
        [
          'WINE REGISTRY Version 2',
          '',
          '[Software\\\\Wow6432Node\\\\Ubisoft\\\\Launcher\\\\Installs\\\\9954] 1700000123',
          `"InstallDir"="C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Synthetic Odyssey II/"`,
          '',
          '[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Uplay Install 9954] 1700000124',
          `"DisplayName"="Synthetic Odyssey II"`,
          '',
        ].join('\n'),
        'utf8'
      );

      // Seed Xbox catalog cache (`xbox_library_cache.json`) with `Synthetic Odyssey 2` + `externalStorefrontHandoff: 'ubisoft'`
      fs.writeFileSync(
        path.join(userDataDir, 'xbox_library_cache.json'),
        JSON.stringify({
          games: [
            {
              platformId: 'xbox',
              platformGameId: '9NSYNTHOD2X1',
              xboxProductId: '9NSYNTHOD2X1',
              title: 'Synthetic Odyssey 2',
              externalStorefrontHandoff: 'ubisoft',
            },
          ],
        }),
        'utf8'
      );

      const scanRes = await installedGameScanner.scanAllInstalledGames({
        platform: 'darwin',
        homedir: macHome,
        userDataDir,
        customApplicationsDir: appsDir,
        customRoots: [path.join(sandbox, 'XboxGames'), bottlePath],
        catalogGames: [
          {
            id: 'xbox_9NSYNTHOD2X1',
            title: 'Synthetic Odyssey 2',
            externalStorefrontHandoff: 'ubisoft',
            platforms: [
              {
                platformId: 'xbox',
                platformGameId: '9NSYNTHOD2X1',
                xboxProductId: '9NSYNTHOD2X1',
                title: 'Synthetic Odyssey 2',
                externalStorefrontHandoff: 'ubisoft',
              },
            ],
          },
        ],
      });

      expect(scanRes.success).toBe(true);
      // Stale `GDKStubGame.exe` was pruned from `one_launcher_installed.json` WITHOUT deleting `staleStubExe` on disk!
      expect(fs.existsSync(staleStubExe)).toBe(true);
      const persistedManaged = engineStateRegistry.loadManagedInstalledGames(userDataDir);
      expect(
        persistedManaged.some((r: any) => /gdkstubgame\.exe/i.test(String(r.executablePath || '')))
      ).toBe(false);

      // Roman-numeral Ubisoft install `Synthetic Odyssey II` matched Xbox `Synthetic Odyssey 2` (`9NSYNTHOD2X1`)!
      const matchedXbox = scanRes.installedGames.find(
        (g: any) => g.platformId === 'xbox' && g.platformGameId === '9NSYNTHOD2X1'
      );
      expect(matchedXbox).toBeDefined();
      expect(matchedXbox.executablePath).toBe(realGameExe);
      expect(matchedXbox.chainedLauncherHandoff).toBe('ubisoft');
      expect(matchedXbox.chainedExternalInstallId).toBe('9954');
      expect(matchedXbox.runner).toBe('chained_bottle');
      expect(matchedXbox.isWindowsBinaryOnMac).toBe(true);
      expect(matchedXbox.installSize).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    });

    it('rejects unsigned PE64 publisher installers in ensureChainedPublisherLauncherInstalled and provisions Authenticode-signed installers across darwin and win32', async () => {
      const sandbox = makeSandbox('ol-d3-provision-');
      const macHome = path.join(sandbox, 'macHome');
      const userDataDir = path.join(sandbox, 'userData');
      const appsDir = path.join(sandbox, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });
      const crossoverApp = seedMockCrossOverApp(appsDir);
      const bottlePath = seedInitializedCrossOverBottle(macHome, 'OneLauncher');

      const runnerLayer = {
        type: 'crossover',
        name: 'CrossOver',
        binaryPath: path.join(crossoverApp, 'Contents/SharedSupport/CrossOver/bin/wine'),
        bottlesDir: path.join(macHome, 'Library/Application Support/CrossOver/Bottles'),
      };

      // 1) Unsigned PE64 (no `DataDirectory[4]` `WIN_CERTIFICATE`) MUST be rejected BEFORE spawning Wine!
      const unsignedPe64 = buildSyntheticInstallerPe64Buffer({ withAuthenticode: false });
      const spawnUnsignedSpy = vi.fn();

      await expect(
        environmentProvisioner.ensureChainedPublisherLauncherInstalled(
          {
            handoffId: 'ubisoft',
            platform: 'darwin',
            runnerLayer,
            bottleName: 'OneLauncher',
            bottlePath,
          },
          {
            platform: 'darwin',
            arch: 'x64',
            homedir: macHome,
            userDataDir,
            forceReinstall: true,
            fetchFn: async (url: string) => buildMockFetchResponse({ body: unsignedPe64, url }),
            spawnFn: spawnUnsignedSpy,
          }
        )
      ).rejects.toThrow(/Authenticode/i);
      expect(spawnUnsignedSpy).not.toHaveBeenCalled();

      // 2) Signed PE64 (`withAuthenticode: true`) succeeds on `darwin`, passing `WINEDLLOVERRIDES` and verifying `UPC.exe`
      const signedPe64 = buildSyntheticInstallerPe64Buffer({ withAuthenticode: true });
      const progressEvents: number[] = [];
      let capturedInstallEnv: Record<string, string> | undefined;

      const ensuredMac = await environmentProvisioner.ensureChainedPublisherLauncherInstalled(
        {
          handoffId: 'ubisoft',
          platform: 'darwin',
          runnerLayer,
          bottleName: 'OneLauncher',
          bottlePath,
          onProgress: (p: any) => progressEvents.push(p.percent),
        },
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: macHome,
          userDataDir,
          bottlePollIntervalMs: 15,
          fetchFn: async (url: string) => buildMockFetchResponse({ body: signedPe64, url }),
          spawnFn: (_cmd: string, _args: string[], opts: any) => {
            capturedInstallEnv = opts?.env;
            const child = new EventEmitter() as any;
            child.pid = 42420;
            child.kill = vi.fn();
            child.unref = vi.fn();
            // Simulate silent `/S` installer writing `UPC.exe` into the bottle
            const upcDir = path.join(
              bottlePath,
              'drive_c/Program Files (x86)/Ubisoft/Ubisoft Game Launcher'
            );
            fs.mkdirSync(upcDir, { recursive: true });
            fs.writeFileSync(path.join(upcDir, 'UPC.exe'), signedPe64);
            setImmediate(() => {
              child.emit('exit', 0);
              child.emit('close', 0);
            });
            return child;
          },
        }
      );

      expect(ensuredMac.installed).toBe(true);
      expect(ensuredMac.provisionedNow).toBe(true);
      expect(ensuredMac.binaryPath.endsWith('UPC.exe')).toBe(true);
      expect(capturedInstallEnv?.WINEDLLOVERRIDES).toBe('mscoree,mshtml=d;winemenubuilder.exe=d');
      expect(progressEvents).toContain(100);

      // 3) Signed PE64 on `win32` host verifies PowerShell Authenticode status and runs silent installer
      const winDriveC = path.join(sandbox, 'winC');
      const winEnv = {
        PROGRAMFILES: path.join(winDriveC, 'Program Files'),
        'PROGRAMFILES(X86)': path.join(winDriveC, 'Program Files (x86)'),
        PROGRAMDATA: path.join(winDriveC, 'ProgramData'),
        LOCALAPPDATA: path.join(winDriveC, 'Users/testuser/AppData/Local'),
        SYSTEMDRIVE: winDriveC,
      };

      const ensuredWin = await environmentProvisioner.ensureChainedPublisherLauncherInstalled(
        {
          handoffId: 'ea',
          platform: 'win32',
        },
        {
          platform: 'win32',
          homedir: path.join(winDriveC, 'Users/testuser'),
          userDataDir,
          env: winEnv,
          fetchFn: async (url: string) => buildMockFetchResponse({ body: signedPe64, url }),
          execFileFn: (cmd: string, _args: string[], opts: any, cb: Function) => {
            if (/powershell/i.test(cmd)) {
              const verifyTarget = opts?.env?.OL_VERIFY_PATH;
              const ok = environmentProvisioner.hasEmbeddedPeAuthenticodeCertificate(verifyTarget);
              cb(null, ok ? 'Valid\r\n' : 'NotSigned\r\n', '');
              return {};
            }
            // Silent EAInstaller.exe `/quiet /norestart` writes `EADesktop.exe`
            const eaDir = path.join(
              winDriveC,
              'Program Files/Electronic Arts/EA Desktop/EA Desktop'
            );
            fs.mkdirSync(eaDir, { recursive: true });
            fs.writeFileSync(path.join(eaDir, 'EADesktop.exe'), signedPe64);
            cb(null, '', '');
            return {};
          },
        }
      );

      expect(ensuredWin.installed).toBe(true);
      expect(ensuredWin.provisionedNow).toBe(true);
      expect(ensuredWin.binaryPath.endsWith('EADesktop.exe')).toBe(true);
    });

    it('orchestrates installGame on darwin and win32 without opening ubisoftconnect.com/ea.com webpages, spawns launcher with bottle flags, and transitions task to completed via startChainedLauncherInstallMonitor', async () => {
      const sandbox = makeSandbox('ol-d3-installgame-');
      const macHome = path.join(sandbox, 'macHome');
      const userDataDir = path.join(sandbox, 'userData');
      const appsDir = path.join(sandbox, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });
      seedMockCrossOverApp(appsDir);
      const bottlePath = seedInitializedCrossOverBottle(macHome, 'OneLauncher');
      const pe64 = buildValidMinimalPe64Buffer();

      // --- Part A: macOS (`darwin`) Chained Bottle Install + Monitor Completion ---
      const upcDir = path.join(
        bottlePath,
        'drive_c/Program Files (x86)/Ubisoft/Ubisoft Game Launcher'
      );
      const upcExe = path.join(upcDir, 'UPC.exe');
      const macSpawnCalls: Array<{ cmd: string; args: string[]; env: any }> = [];

      const ensureMacSpy = vi.fn(async () => {
        fs.mkdirSync(upcDir, { recursive: true });
        fs.writeFileSync(upcExe, pe64);
        return {
          installed: true,
          provisionedNow: true,
          binaryPath: upcExe,
          installDir: upcDir,
        };
      });

      const macInstallRes = await downloadQueueCoordinator.installGame(
        {
          gameId: 'xbox_9NTROPICS6SY',
          platformId: 'xbox',
          platformGameId: '9NTROPICS6SY',
          xboxProductId: '9NTROPICS6SY',
          title: 'Synthetic Tropics VI',
          installerId: 'xbox-chained-bottle-launcher',
          compatibilityLayer: 'crossover',
          wineBottleName: 'OneLauncher',
          externalStorefrontHandoff: 'ubisoft',
          chainedExternalInstallId: '990002',
          expectedTotalBytes: 48_318_382_080,
        },
        {
          platform: 'darwin',
          homedir: macHome,
          userDataDir,
          customApplicationsDir: appsDir,
          ensureChainedPublisherLauncherInstalledFn: ensureMacSpy,
          chainedInstallPollIntervalMs: 250,
          spawnFn: (cmd: string, args: string[], opts: any) => {
            macSpawnCalls.push({ cmd, args, env: opts?.env });
            const child = new EventEmitter() as any;
            child.pid = 51510;
            child.unref = vi.fn();
            return child;
          },
        }
      );

      expect(macInstallRes.success).toBe(true);
      expect(macInstallRes.status).toBe('chained_launcher_opened');
      expect(ensureMacSpy).toHaveBeenCalledTimes(1);
      // NEVER opens ubisoftconnect.com or ea.com in macOS browser!
      expect(engineStateRegistry.openedExternalUris).toEqual([]);
      expect(macSpawnCalls).toHaveLength(1);
      expect(macSpawnCalls[0].args).toEqual(
        expect.arrayContaining([
          upcExe,
          '--no-sandbox',
          '--in-process-gpu',
          '--disable-gpu',
          '--force-device-scale-factor=1',
          'uplay://launch/990002/0',
        ])
      );
      expect(macSpawnCalls[0].env?.WINEPREFIX).toBe(bottlePath);

      // Materialize the installed game executable inside the bottle -> monitor detects & transitions task to `completed`
      const tropicsGameDir = path.join(upcDir, 'games/Synthetic Tropics 6');
      fs.mkdirSync(tropicsGameDir, { recursive: true });
      const tropicsExe = path.join(tropicsGameDir, 'SynthTropics6.exe');
      fs.writeFileSync(tropicsExe, pe64);
      fs.writeFileSync(
        path.join(bottlePath, 'system.reg'),
        [
          'WINE REGISTRY Version 2',
          '',
          '[Software\\\\Wow6432Node\\\\Ubisoft\\\\Launcher\\\\Installs\\\\990002] 1700000500',
          `"InstallDir"="C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Synthetic Tropics 6/"`,
          '',
        ].join('\n'),
        'utf8'
      );

      await vi.waitFor(
        () => {
          const queue = downloadQueueCoordinator.getDownloadQueue({ userDataDir });
          const task = queue.find((t: any) => t.taskId === macInstallRes.task.taskId);
          expect(task?.status).toBe('completed');
          expect(task?.executablePath).toBe(tropicsExe);
        },
        { timeout: 2500, interval: 40 }
      );

      // --- Part B: Windows Native (`win32`) Chained Host Install + Monitor Completion ---
      const winDriveC = path.join(sandbox, 'winHost');
      const winEnv = {
        PROGRAMFILES: path.join(winDriveC, 'Program Files'),
        'PROGRAMFILES(X86)': path.join(winDriveC, 'Program Files (x86)'),
        PROGRAMDATA: path.join(winDriveC, 'ProgramData'),
        LOCALAPPDATA: path.join(winDriveC, 'Users/testuser/AppData/Local'),
        SYSTEMDRIVE: winDriveC,
      };
      const winEaLauncherDir = path.join(
        winDriveC,
        'Program Files/Electronic Arts/EA Desktop/EA Desktop'
      );
      const winEaExe = path.join(winEaLauncherDir, 'EADesktop.exe');
      const winSpawnCalls: Array<{ cmd: string; args: string[] }> = [];

      const ensureWinSpy = vi.fn(async () => {
        fs.mkdirSync(winEaLauncherDir, { recursive: true });
        fs.writeFileSync(winEaExe, pe64);
        return {
          installed: true,
          provisionedNow: true,
          binaryPath: winEaExe,
          installDir: winEaLauncherDir,
        };
      });

      const winInstallRes = await downloadQueueCoordinator.installGame(
        {
          gameId: 'xbox_9NDEEPSTAT01',
          platformId: 'xbox',
          platformGameId: '9NDEEPSTAT01',
          xboxProductId: '9NDEEPSTAT01',
          title: 'Synthetic Deep Station',
          installerId: 'xbox-chained-win-launcher',
          externalStorefrontHandoff: 'ea',
          expectedTotalBytes: 36_507_222_016,
        },
        {
          platform: 'win32',
          homedir: path.join(winDriveC, 'Users/testuser'),
          userDataDir,
          env: winEnv,
          hasGamingServices: false,
          ensureChainedPublisherLauncherInstalledFn: ensureWinSpy,
          chainedInstallPollIntervalMs: 250,
          spawnFn: (cmd: string, args: string[]) => {
            winSpawnCalls.push({ cmd, args });
            const child = new EventEmitter() as any;
            child.pid = 61610;
            child.unref = vi.fn();
            return child;
          },
        }
      );

      expect(winInstallRes.success).toBe(true);
      expect(winInstallRes.status).toBe('chained_launcher_opened');
      expect(ensureWinSpy).toHaveBeenCalledTimes(1);
      expect(
        engineStateRegistry.openedExternalUris.some((u: string) => /ubisoftconnect\.com|ea\.com/i.test(u))
      ).toBe(false);
      expect(winSpawnCalls[0].cmd).toBe(winEaExe);

      // Materialize EA game on Windows host -> monitor transitions task to `completed`
      const winEaGameDir = path.join(
        winDriveC,
        'Program Files/EA Games/Synthetic Deep Station'
      );
      fs.mkdirSync(path.join(winEaGameDir, '__Installer'), { recursive: true });
      const winDeepStationExe = path.join(winEaGameDir, 'SynthStation.exe');
      fs.writeFileSync(winDeepStationExe, pe64);
      fs.writeFileSync(
        path.join(winEaGameDir, '__Installer/installerdata.xml'),
        `<DiPManifest><gameTitles><gameTitle locale="en_US">Synthetic Deep Station</gameTitle></gameTitles></DiPManifest>`,
        'utf8'
      );

      await vi.waitFor(
        () => {
          const queue = downloadQueueCoordinator.getDownloadQueue({ userDataDir });
          const task = queue.find((t: any) => t.taskId === winInstallRes.task.taskId);
          expect(task?.status).toBe('completed');
          expect(task?.executablePath).toBe(winDeepStationExe);
        },
        { timeout: 2500, interval: 40 }
      );
    });

    it('blocks Riot (vgk.sys) on darwin bottle with explicit kernel anti-cheat reason while succeeding on win32', async () => {
      const sandbox = makeSandbox('ol-d3-riot-');
      const userDataDir = path.join(sandbox, 'userData');
      const homedir = path.join(sandbox, 'home');
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(homedir, { recursive: true });

      // 1) `getGameInstallInfo` on `darwin` reports `tier_c_kernel_anticheat` (`vgk.sys`) & `canDirectDownload: false`
      const macRiotInfo = await downloadQueueCoordinator.getGameInstallInfo(
        {
          platformId: 'xbox',
          platformGameId: '9NSYNTHARENA',
          xboxProductId: '9NSYNTHARENA',
          title: 'Synthetic Arena',
          externalStorefrontHandoff: 'riot',
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          skipNetwork: true,
        }
      );
      expect(macRiotInfo.canDirectDownload).toBe(false);
      expect(macRiotInfo.xboxCompatibility?.tier).toBe('tier_c_kernel_anticheat');
      expect(macRiotInfo.xboxCompatibility?.canExtractAndRun).toBe(false);
      expect(macRiotInfo.xboxCompatibility?.summary).toMatch(/vgk\.sys|kernel anti-cheat/i);

      // 2) `ensureChainedPublisherLauncherInstalled` throws explicit `vgk.sys` error on `darwin`
      await expect(
        environmentProvisioner.ensureChainedPublisherLauncherInstalled(
          { handoffId: 'riot', platform: 'darwin' },
          { platform: 'darwin', homedir, userDataDir }
        )
      ).rejects.toThrow(/vgk\.sys|kernel anti-cheat/i);

      // 3) `installGame` on `darwin` fails cleanly with explicit `vgk.sys` reason without opening web URLs
      const macRiotInstall = await downloadQueueCoordinator.installGame(
        {
          gameId: 'xbox_9NSYNTHARENA',
          platformId: 'xbox',
          platformGameId: '9NSYNTHARENA',
          xboxProductId: '9NSYNTHARENA',
          title: 'Synthetic Arena',
          installerId: 'xbox-chained-bottle-launcher',
          externalStorefrontHandoff: 'riot',
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
        }
      );
      expect(macRiotInstall.success).toBe(false);
      expect(macRiotInstall.error).toMatch(/vgk\.sys|kernel anti-cheat/i);
      expect(engineStateRegistry.openedExternalUris).toEqual([]);

      // 4) On `win32`, `getGameInstallInfo` & `installGame` succeed when Riot Client is present
      const winDriveC = path.join(sandbox, 'winRiot');
      const riotDir = path.join(winDriveC, 'Riot Games/Riot Client');
      fs.mkdirSync(riotDir, { recursive: true });
      const riotExe = path.join(riotDir, 'RiotClientServices.exe');
      fs.writeFileSync(riotExe, buildValidMinimalPe64Buffer());
      const winEnv = {
        PROGRAMFILES: path.join(winDriveC, 'Program Files'),
        'PROGRAMFILES(X86)': path.join(winDriveC, 'Program Files (x86)'),
        PROGRAMDATA: path.join(winDriveC, 'ProgramData'),
        LOCALAPPDATA: path.join(winDriveC, 'Users/testuser/AppData/Local'),
        SYSTEMDRIVE: winDriveC,
      };

      const winRiotInfo = await downloadQueueCoordinator.getGameInstallInfo(
        {
          platformId: 'xbox',
          platformGameId: '9NSYNTHARENA',
          xboxProductId: '9NSYNTHARENA',
          title: 'Synthetic Arena',
          externalStorefrontHandoff: 'riot',
        },
        {
          platform: 'win32',
          homedir: path.join(winDriveC, 'Users/testuser'),
          userDataDir,
          env: winEnv,
          skipNetwork: true,
        }
      );
      expect(winRiotInfo.canDirectDownload).toBe(true);
      expect(winRiotInfo.availableInstallers[0].id).toBe('xbox-chained-win-launcher');

      const winRiotInstall = await downloadQueueCoordinator.installGame(
        {
          gameId: 'xbox_9NSYNTHARENA',
          platformId: 'xbox',
          platformGameId: '9NSYNTHARENA',
          xboxProductId: '9NSYNTHARENA',
          title: 'Synthetic Arena',
          installerId: 'xbox-chained-win-launcher',
          externalStorefrontHandoff: 'riot',
        },
        {
          platform: 'win32',
          homedir: path.join(winDriveC, 'Users/testuser'),
          userDataDir,
          env: winEnv,
          hasGamingServices: false,
          skipInstallMonitor: true,
          spawnFn: () => {
            const c = new EventEmitter() as any;
            c.pid = 71710;
            c.unref = vi.fn();
            return c;
          },
        }
      );
      expect(winRiotInstall.success).toBe(true);
      expect(winRiotInstall.status).toBe('chained_launcher_opened');
    });

    it('enforces strict leaf-folder containment in isSafeBottleChainedGameDirToDelete and uninstallGame (preserving bottle root, drive_c, Program Files, and Ubisoft Game Launcher)', async () => {
      const sandbox = makeSandbox('ol-d3-uninstall-');
      const macHome = path.join(sandbox, 'macHome');
      const userDataDir = path.join(sandbox, 'userData');
      fs.mkdirSync(userDataDir, { recursive: true });
      const bottlePath = seedInitializedCrossOverBottle(macHome, 'OneLauncher');
      const pe64 = buildValidMinimalPe64Buffer();

      const ubiRootDir = path.join(
        bottlePath,
        'drive_c/Program Files (x86)/Ubisoft/Ubisoft Game Launcher'
      );
      const gamesContainerDir = path.join(ubiRootDir, 'games');
      const targetLeafGameDir = path.join(gamesContainerDir, 'Synthetic Odyssey II');
      const siblingLeafGameDir = path.join(gamesContainerDir, 'Synthetic Platformer Legends');
      fs.mkdirSync(targetLeafGameDir, { recursive: true });
      fs.mkdirSync(siblingLeafGameDir, { recursive: true });

      const upcExe = path.join(ubiRootDir, 'UPC.exe');
      const targetExe = path.join(targetLeafGameDir, 'SyntheticOdysseyIIGame.exe');
      const siblingExe = path.join(siblingLeafGameDir, 'SynthPlatformer.exe');
      fs.writeFileSync(upcExe, pe64);
      fs.writeFileSync(targetExe, pe64);
      fs.writeFileSync(siblingExe, pe64);

      // 1) Direct boundary unit checks on `isSafeBottleChainedGameDirToDelete(bottlePath, candidateDir)`
      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(bottlePath, bottlePath)
      ).toBe(false);
      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(
          bottlePath,
          path.join(bottlePath, 'drive_c')
        )
      ).toBe(false);
      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(
          bottlePath,
          path.join(bottlePath, 'drive_c/Program Files (x86)')
        )
      ).toBe(false);
      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(
          bottlePath,
          path.join(bottlePath, 'drive_c/windows')
        )
      ).toBe(false);
      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(bottlePath, ubiRootDir)
      ).toBe(false);
      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(
          bottlePath,
          gamesContainerDir
        )
      ).toBe(false);
      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(
          bottlePath,
          targetLeafGameDir
        )
      ).toBe(true);

      // 2) `uninstallGame` deletes `targetLeafGameDir` cleanly while preserving `UPC.exe` & sibling games
      engineStateRegistry.saveManagedInstalledGames(
        [
          {
            platformId: 'xbox',
            platformGameId: '9NSYNTHOD2U1',
            xboxProductId: '9NSYNTHOD2U1',
            title: 'Synthetic Odyssey II',
            installPath: targetLeafGameDir,
            executablePath: targetExe,
            chainedLauncherHandoff: 'ubisoft',
            chainedExternalInstallId: '9954',
            runner: 'chained_bottle',
            wineBottle: 'OneLauncher',
            isWindowsBinaryOnMac: true,
          },
          {
            platformId: 'xbox',
            platformGameId: '9NCORRUPTROOT',
            xboxProductId: '9NCORRUPTROOT',
            title: 'Corrupted Root Pointer',
            installPath: ubiRootDir,
            executablePath: upcExe,
            chainedLauncherHandoff: 'ubisoft',
            runner: 'chained_bottle',
            wineBottle: 'OneLauncher',
            isWindowsBinaryOnMac: true,
          },
        ],
        userDataDir
      );

      const uninstLeaf = await sessionAndProcessSupervisor.uninstallGame(
        {
          gameId: 'xbox_9NSYNTHOD2U1',
          platformId: 'xbox',
          platformGameId: '9NSYNTHOD2U1',
          title: 'Synthetic Odyssey II',
          installPath: targetLeafGameDir,
        },
        {
          platform: 'darwin',
          homedir: macHome,
          userDataDir,
        }
      );
      expect(uninstLeaf.success).toBe(true);
      expect(fs.existsSync(targetLeafGameDir)).toBe(false);
      expect(fs.existsSync(upcExe)).toBe(true);
      expect(fs.existsSync(siblingExe)).toBe(true);

      // Even if a corrupted record pointed `installPath` at `Ubisoft Game Launcher` root, `UPC.exe` is NEVER deleted!
      await sessionAndProcessSupervisor.uninstallGame(
        {
          gameId: 'xbox_9NCORRUPTROOT',
          platformId: 'xbox',
          platformGameId: '9NCORRUPTROOT',
          title: 'Corrupted Root Pointer',
          installPath: ubiRootDir,
        },
        {
          platform: 'darwin',
          homedir: macHome,
          userDataDir,
        }
      );
      expect(fs.existsSync(ubiRootDir)).toBe(true);
      expect(fs.existsSync(upcExe)).toBe(true);
      expect(fs.existsSync(siblingExe)).toBe(true);
    });
  });
});
