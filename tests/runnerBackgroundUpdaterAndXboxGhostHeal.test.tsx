import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const idbStore = new Map<string, unknown>();
  return { idbStore };
});

vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => 'mock-vault-store'),
  get: vi.fn(async (key: string) => {
    const val = hoisted.idbStore.get(key);
    return val === undefined ? undefined : structuredClone(val);
  }),
  set: vi.fn(async (key: string, val: unknown) => {
    hoisted.idbStore.set(key, structuredClone(val));
  }),
  del: vi.fn(async (key: string) => {
    hoisted.idbStore.delete(key);
  }),
  clear: vi.fn(async () => {
    hoisted.idbStore.clear();
  }),
  keys: vi.fn(async () => Array.from(hoisted.idbStore.keys())),
}));

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';

import type { CanonicalGame } from '../src/contracts/game';
import type {
  CompatibilityLayerInfo,
  CompatibilityLayerUpdateInfo,
  CompatibilityRunnerProgressEvent,
  GameLaunchConfig,
  InstalledGameRecord,
} from '../src/contracts/launcher';
import type {
  EnvironmentComponentId,
  EnvironmentComponentState,
  EnvironmentHealthSnapshot,
} from '../src/contracts/environmentSetup';
import type { StorefrontId } from '../src/contracts/platform';

import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import {
  formatRunnerSecondaryBuildText,
  formatUserFacingPath,
} from '../src/components/Launcher/LaunchConfig/launchConfigHelpers';
import { CompatibilityAndBottleStep } from '../src/components/Launcher/SystemSetupWizard/steps/CompatibilityAndBottleStep';
import { ProvisioningProgressPanel } from '../src/components/Launcher/SystemSetupWizard/steps/ProvisioningProgressPanel';
import { LibraryGridView } from '../src/components/Library/LibraryGridView';
import { LibrarySidebar } from '../src/components/Library/LibrarySidebar';
import { PlatformBadges } from '../src/components/SteamStoreDetail/PlatformBadges';

import {
  buildProvisioningTasksFromSelection,
  EnvironmentSetupService,
  environmentSetupService,
} from '../src/services/launcher/environmentSetupService';
import { LauncherService, launcherService } from '../src/services/launcher/launcherService';
import {
  clearIntegrationStorage,
  flushPendingCatalogSave,
  hydrateCatalogFromIndexedDb,
  mergeStorefrontGames,
  mergeUpdatedGamePreservingLivePlatformState,
  reconcileCatalogGamesWithInstalledRecords,
  recordVerifiedUserEntitlements,
} from '../src/services/integrations/integrationStorage';
import {
  clearSuppressedCatalogEntries,
  sanitizeGameCatalog,
} from '../src/services/integrations/catalogSanitizer';
import { reconcileLocalInstallationsPure } from '../src/hooks/useLocalInstallSync';

import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  federatorMod,
  findElements,
  getTextContent,
  makeCanonicalGameFixture,
  offlineVaultMod,
  xboxCatalogAndGamePass,
} from './helpers/xboxTestHarness';
import { scanContentForPiiViolations } from './helpers/piiHygieneGuard';

const nodeRequire = createRequire(import.meta.url);
const environmentProvisioner = nodeRequire('../electron/launcher/environmentProvisioner.cjs');
const environmentHealthProber = nodeRequire('../electron/launcher/environmentHealthProber.cjs');
const macNativeInstaller = nodeRequire('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const launcherIpcHandlers = nodeRequire('../electron/ipc/launcherIpcHandlers.cjs');
const engineStateRegistry = nodeRequire('../electron/launcher/engineStateRegistry.cjs');

const IDB_KEY_MAIN_CATALOG = 'idb_universal_game_library_catalog_v2';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THIS_TEST_FILE_PATH = fileURLToPath(import.meta.url);

// ============================================================================
// Hermetic Network Socket Guard & WCAG 2.2 AA Auditor
// ============================================================================

function installHermeticOfflineSocketGuard(): () => void {
  const origConnect = net.Socket.prototype.connect;
  const connectSpy = vi
    .spyOn(net.Socket.prototype, 'connect')
    .mockImplementation(function (this: net.Socket, ...args: any[]) {
      const first = args[0];
      const host =
        typeof first === 'object' && first !== null
          ? String(first.host || '127.0.0.1')
          : typeof args[1] === 'string'
            ? args[1]
            : '127.0.0.1';
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
        throw new Error(`Hermetic test blocked outbound TCP socket connection to ${host}`);
      }
      return origConnect.apply(this, args as any);
    });
  return () => {
    connectSpy.mockRestore();
  };
}

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

function auditWcag22AA(tree: any): string[] {
  const violations: string[] = [];
  const allElements = findVNodes(tree, (n) => typeof n.type === 'string');

  const elementsById = new Map<string, any>();
  const labelForIds = new Set<string>();
  const implicitlyLabelledControls = new WeakSet<object>();

  for (const el of allElements) {
    const id = el.props?.id;
    if (typeof id === 'string' && id.trim()) {
      if (elementsById.has(id)) {
        violations.push(`duplicate-id: Duplicate id="${id}" on <${el.type}>`);
      } else {
        elementsById.set(id, el);
      }
    }
    if (el.type === 'label') {
      if (typeof el.props?.htmlFor === 'string' && el.props.htmlFor.trim()) {
        labelForIds.add(el.props.htmlFor.trim());
      } else if (extractVNodeText(el).trim().length > 0) {
        const nestedControls = findVNodes(
          el,
          (n) => n.type === 'input' || n.type === 'select' || n.type === 'textarea'
        );
        if (nestedControls.length === 1) {
          implicitlyLabelledControls.add(nestedControls[0]);
        }
      }
    }
  }

  const html = renderToStaticMarkup(tree as React.ReactElement);
  const parseErrors: string[] = [];
  new XmlDomParser({
    errorHandler: {
      warning: () => {},
      error: (msg: string) => parseErrors.push(msg),
      fatalError: (msg: string) => parseErrors.push(msg),
    },
  }).parseFromString(`<div>${html}</div>`, 'text/html');
  if (parseErrors.length > 0) {
    violations.push(`html-well-formedness: ${parseErrors.join('; ')}`);
  }

  for (const el of allElements) {
    const tag = el.type as string;
    const props = el.props || {};
    const testId = props['data-testid'] ? `[data-testid="${props['data-testid']}"]` : `<${tag}>`;

    for (const refAttr of ['aria-labelledby', 'aria-describedby'] as const) {
      if (typeof props[refAttr] === 'string' && props[refAttr].trim()) {
        for (const refId of props[refAttr].trim().split(/\s+/)) {
          if (!elementsById.has(refId)) {
            violations.push(
              `aria-valid-attr-value: ${testId} has ${refAttr}="${refId}" referencing non-existent id`
            );
          }
        }
      }
    }
    if (tag === 'label' && typeof props.htmlFor === 'string' && props.htmlFor.trim()) {
      if (!elementsById.has(props.htmlFor.trim())) {
        violations.push(
          `label-ValidFor: <label htmlFor="${props.htmlFor}"> references non-existent control id`
        );
      }
    }

    if (tag === 'dialog') {
      const hasLabelledBy =
        typeof props['aria-labelledby'] === 'string' &&
        props['aria-labelledby']
          .trim()
          .split(/\s+/)
          .every((id: string) => {
            const target = elementsById.get(id);
            return Boolean(target && extractVNodeText(target).trim().length > 0);
          });
      const hasAriaLabel =
        typeof props['aria-label'] === 'string' && props['aria-label'].trim().length > 0;
      if (!hasLabelledBy && !hasAriaLabel) {
        violations.push(`dialog-name: ${testId} lacks accessible name`);
      }
    }

    if (tag === 'button') {
      if (!['button', 'submit', 'reset'].includes(String(props.type || ''))) {
        violations.push(`button-type: ${testId} is missing explicit type="button|submit|reset"`);
      }
      const visibleText = extractVNodeText(el).trim();
      const ariaLabel = typeof props['aria-label'] === 'string' ? props['aria-label'].trim() : '';
      const ariaLabelledBy =
        typeof props['aria-labelledby'] === 'string' ? props['aria-labelledby'].trim() : '';
      if (!visibleText && !ariaLabel && !ariaLabelledBy) {
        violations.push(`button-name: ${testId} lacks accessible name`);
      }
      if (props.role === 'switch' && typeof props['aria-checked'] !== 'boolean') {
        violations.push(`aria-required-attr: ${testId} role="switch" lacks boolean aria-checked`);
      }
      const cls = String(props.className || '');
      const hasMinTarget =
        /\bmin-h-(?:6|7|8|9|10|11|12)\b/.test(cls) ||
        /\bh-(?:6|7|8|9|10|11|12)\b/.test(cls) ||
        /\bp-(?:1\.5|2|2\.5|3|3\.5|4)\b/.test(cls) ||
        /\bpy-(?:1|1\.5|2|2\.5|3)\b/.test(cls);
      if (!hasMinTarget) {
        violations.push(
          `target-size (WCAG 2.2 SC 2.5.8): ${testId} lacks >=24px target sizing class ("${cls}")`
        );
      }
    }

    if (tag === 'progress') {
      const ariaLabel = typeof props['aria-label'] === 'string' ? props['aria-label'].trim() : '';
      const ariaLabelledBy =
        typeof props['aria-labelledby'] === 'string' ? props['aria-labelledby'].trim() : '';
      if (!ariaLabel && !ariaLabelledBy) {
        violations.push(`progressbar-name: ${testId} lacks accessible name`);
      }
      if (props.value !== undefined && (typeof props.value !== 'number' || Number.isNaN(props.value))) {
        violations.push(`progressbar-value: ${testId} has invalid progress value`);
      }
    }

    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (props.type === 'hidden') continue;
      const ariaLabel = typeof props['aria-label'] === 'string' ? props['aria-label'].trim() : '';
      const ariaLabelledBy =
        typeof props['aria-labelledby'] === 'string' ? props['aria-labelledby'].trim() : '';
      const hasExplicitLabel = typeof props.id === 'string' && labelForIds.has(props.id);
      const hasImplicitLabel = implicitlyLabelledControls.has(el);
      if (!ariaLabel && !ariaLabelledBy && !hasExplicitLabel && !hasImplicitLabel) {
        violations.push(`label: ${testId} (${tag}) lacks accessible label`);
      }
    }

    if (
      tag !== 'svg' &&
      tag !== 'path' &&
      props['aria-hidden'] !== 'true' &&
      props['aria-hidden'] !== true &&
      props.disabled !== true
    ) {
      const cls = String(props.className || '');
      if (
        /\btext-(?:slate|gray|zinc)-[56789]00\b/.test(cls) &&
        extractVNodeText(el).trim().length > 0
      ) {
        violations.push(`color-contrast: ${testId} uses low-contrast muted text class ("${cls}")`);
      }
    }
  }

  return violations;
}

// ============================================================================
// Synthetic Runner Bundle & Xbox DisplayCatalog / SIGL v3 Helpers
// ============================================================================

function seedSyntheticCrossOverApp(
  appsDir: string,
  appName: string,
  shortVersion: string,
  bundleVersion: string
): string {
  const appPath = path.join(appsDir, appName);
  const binDir = path.join(appPath, 'Contents/SharedSupport/CrossOver/bin');
  const macOsDir = path.join(appPath, 'Contents/MacOS');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(macOsDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'wineserver'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(macOsDir, 'CrossOver'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(appPath, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.codeweavers.CrossOver</string>
  <key>CFBundleShortVersionString</key>
  <string>${shortVersion}</string>
  <key>CFBundleVersion</key>
  <string>${bundleVersion}</string>
</dict>
</plist>\n`,
    'utf8'
  );
  return appPath;
}

function makeSyntheticComponentState(
  id: EnvironmentComponentId,
  overrides: Partial<EnvironmentComponentState> = {}
): EnvironmentComponentState {
  return {
    id,
    category: 'compatibility_runner',
    title: id,
    shortLabel: id,
    status: 'ready',
    recommendationTier: 'optional',
    recommendationBadge: 'Optional',
    defaultSelected: false,
    whyExplanation: `Synthetic component ${id}`,
    statusDetail: 'Ready',
    canAutoInstall: true,
    requiresExternalDownload: false,
    wasPreviouslyConfigured: false,
    ...overrides,
  };
}

function makeSyntheticSetupSnapshot(
  hostPlatform: 'darwin' | 'win32',
  componentOverrides: Partial<Record<EnvironmentComponentId, Partial<EnvironmentComponentState>>> = {}
): EnvironmentHealthSnapshot {
  const baseComponents: Record<EnvironmentComponentId, EnvironmentComponentState> = {
    rosetta2: makeSyntheticComponentState('rosetta2', { category: 'os_prerequisite' }),
    win_vcredist: makeSyntheticComponentState('win_vcredist', { category: 'os_prerequisite' }),
    win_webview2: makeSyntheticComponentState('win_webview2', { category: 'os_prerequisite' }),
    runner_crossover: makeSyntheticComponentState('runner_crossover', {
      title: 'CrossOver',
      shortLabel: 'CrossOver',
      version: '26.3.0',
      recommendationTier: 'recommended',
      ...componentOverrides.runner_crossover,
    }),
    runner_crossover_preview: makeSyntheticComponentState('runner_crossover_preview', {
      title: 'CrossOver Preview',
      shortLabel: 'CrossOver Preview',
      status: 'missing',
      canAutoInstall: false,
      requiresExternalDownload: true,
      ...componentOverrides.runner_crossover_preview,
    }),
    runner_wine: makeSyntheticComponentState('runner_wine', {
      title: 'Open-Source Wine',
      shortLabel: 'Open-Source Wine',
      status: 'missing',
      ...componentOverrides.runner_wine,
    }),
    runner_gptk: makeSyntheticComponentState('runner_gptk', {
      title: 'Apple Game Porting Toolkit',
      shortLabel: 'Apple GPTK',
      status: 'missing',
      canAutoInstall: true,
      requiresExternalDownload: false,
      ...componentOverrides.runner_gptk,
    }),
    bottle_default: makeSyntheticComponentState('bottle_default', {
      category: 'bottle',
      status: 'ready',
    }),
    host_steam: makeSyntheticComponentState('host_steam', { category: 'host_client' }),
    bottle_steam: makeSyntheticComponentState('bottle_steam', { category: 'bottle_client' }),
    host_gog: makeSyntheticComponentState('host_gog', { category: 'host_client' }),
    bottle_gog: makeSyntheticComponentState('bottle_gog', { category: 'bottle_client' }),
    host_epic: makeSyntheticComponentState('host_epic', { category: 'host_client' }),
    bottle_epic: makeSyntheticComponentState('bottle_epic', { category: 'bottle_client' }),
    host_ubisoft: makeSyntheticComponentState('host_ubisoft', { category: 'host_client' }),
    bottle_ubisoft: makeSyntheticComponentState('bottle_ubisoft', { category: 'bottle_client' }),
    host_ea: makeSyntheticComponentState('host_ea', { category: 'host_client' }),
    bottle_ea: makeSyntheticComponentState('bottle_ea', { category: 'bottle_client' }),
    host_bnet: makeSyntheticComponentState('host_bnet', { category: 'host_client' }),
    bottle_bnet: makeSyntheticComponentState('bottle_bnet', { category: 'bottle_client' }),
    host_rockstar: makeSyntheticComponentState('host_rockstar', { category: 'host_client' }),
    bottle_rockstar: makeSyntheticComponentState('bottle_rockstar', { category: 'bottle_client' }),
    xbox_runtime: makeSyntheticComponentState('xbox_runtime', { category: 'built_in_runtime' }),
  };

  return {
    probedAt: '2026-06-15T12:00:00.000Z',
    probeDurationMs: 8,
    hostPlatform,
    hostArch: 'arm64',
    isAppleSiliconMac: hostPlatform === 'darwin',
    hasWriteAccessToSystemApplications: true,
    preferredMacApplicationsDir: '/Applications',
    connectedStorefronts: ['steam', 'xbox'],
    bundledHelpers: {
      gogdlReady: true,
      legendaryReady: true,
      xboxGdkBridgesReady: true,
      metalPreloadReady: true,
    },
    detectedRunners: [],
    bottleSummary: {
      runnerType: hostPlatform === 'darwin' ? 'crossover' : null,
      runnerInstalled: hostPlatform === 'darwin',
      availableBottles:
        hostPlatform === 'darwin'
          ? [
              {
                name: 'OneLauncher',
                path: '/Users/test/Library/Application Support/CrossOver/Bottles/OneLauncher',
                runnerType: 'crossover',
                hasSteam: true,
                hasGogGalaxy: false,
                hasEpicLauncher: false,
                isSandboxed: true,
              },
            ]
          : [],
      recommendedBottleMode: 'reuse_existing',
      recommendedBottleName: 'OneLauncher',
    },
    components: baseComponents,
    clientLogins: {} as any,
    localStoreHints: [],
    counts: {
      readyCount: 5,
      missingRecommendedCount: 0,
      removedSinceLastSetupCount: 0,
      pendingClientLoginCount: 0,
      accountMismatchCount: 0,
      updateAvailableCount: 1,
    },
  };
}

function makeSyntheticDisplayCatalogProduct(opts: {
  productId: string;
  title: string;
  satisfyingEntitlementKeys: string[];
  availabilityStartIso: string;
  availabilityEndIso: string;
}) {
  const pfn = `SyntheticStudio.${opts.productId}_8wekyb3d8bbwe`;
  return {
    ProductId: opts.productId,
    ProductKind: 'Game',
    ProductType: 'Game',
    LocalizedProperties: [
      {
        ProductTitle: opts.title,
        ShortDescription: `Synthetic description for ${opts.title}.`,
        ProductDescription: `Synthetic full description for ${opts.title}.`,
        DeveloperName: 'Synthetic Studio',
        PublisherName: 'Synthetic Publishing',
        Images: [
          {
            ImagePurpose: 'Poster',
            Uri: `//images-eds-ssl.xboxlive.com/image?url=synth_${opts.productId}`,
            Width: 600,
            Height: 900,
          },
        ],
      },
    ],
    MarketProperties: [{ OriginalReleaseDate: '2025-05-01T00:00:00.000Z' }],
    Properties: {
      Category: 'Action & adventure',
      Categories: ['Action & adventure'],
      PackageFamilyName: pfn,
      XboxLiveTier: 'Full',
    },
    AlternateIds: [
      { IdType: 'XboxTitleId', Value: '179900001' },
      { IdType: 'PackageFamilyName', Value: pfn },
    ],
    DisplaySkuAvailabilities: [
      {
        Sku: {
          SkuId: '0010',
          SkuType: 'Full',
          Properties: {
            Packages: [
              {
                PackageId: `pkg-${opts.productId.toLowerCase()}`,
                PackageFormat: 'MSIXVC',
                PackageFullName: `SyntheticStudio.${opts.productId}_1.0.0.0_x64__8wekyb3d8bbwe`,
                ContentId: `00000000-0000-4000-8000-${opts.productId.toLowerCase()}`,
                MaxDownloadSizeInBytes: 8 * 1024 * 1024 * 1024,
                PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
                PackageDownloadUris: [{ Uri: `http://127.0.0.1/msixvc/${opts.productId}.msixvc`, Rank: 1 }],
              },
            ],
            BundledSkus: [],
          },
        },
        Availabilities: [
          {
            Actions: ['Fulfill', 'Launch', 'Browse', 'Details'],
            Conditions: {
              StartDate: opts.availabilityStartIso,
              EndDate: opts.availabilityEndIso,
              ClientConditions: {
                AllowedPlatforms: [{ PlatformName: 'Windows.Desktop' }],
              },
            },
            LicensingData: {
              SatisfyingEntitlementKeys: opts.satisfyingEntitlementKeys.map((k) => ({
                EntitlementKeys: [k],
              })),
            },
            Remediations: [],
            Properties: {},
          },
        ],
      },
    ],
    EligibilityProperties: { Affirmations: [], Remediations: [] },
  };
}

function jsonHttpResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ============================================================================
// Master Verification Suite
// ============================================================================

describe('Wave 3A — Background Runner Updater, Compatibility UI/UX, WCAG 2.2 AA & Xbox Ghost Self-Heal Suite', () => {
  let restoreSocketGuard: () => void;
  let memStorage: Storage;
  const tempDirs: string[] = [];
  let prevElectronApi: unknown;

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ol-w3a-${prefix}-`));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    restoreSocketGuard = installHermeticOfflineSocketGuard();
    memStorage = createMemoryStorage();
    hoisted.idbStore.clear();

    const winObj =
      typeof (globalThis as any).window === 'object' && (globalThis as any).window !== null
        ? (globalThis as any).window
        : {};
    prevElectronApi = winObj.electronAPI;
    Object.assign(winObj, {
      localStorage: memStorage,
      sessionStorage: createMemoryStorage(),
      addEventListener: winObj.addEventListener || (() => {}),
      removeEventListener: winObj.removeEventListener || (() => {}),
      dispatchEvent: winObj.dispatchEvent || (() => true),
      matchMedia:
        winObj.matchMedia ||
        (() => ({
          matches: false,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
        })),
    });
    Object.defineProperty(globalThis, 'window', {
      value: winObj,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: memStorage,
      configurable: true,
      writable: true,
    });

    clearIntegrationStorage();
    clearSuppressedCatalogEntries();
    federatorMod.clearFederatorCaches();
    engineStateRegistry.activeSessions.clear();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        xboxCatalogAndGamePass.closeXboxCatalogCacheStore(dir);
      } catch {}
    }
    engineStateRegistry.activeSessions.clear();
    environmentProvisioner.cancelEnvironmentSetup();
    federatorMod.clearFederatorCaches();
    restoreSocketGuard();
    vi.useRealTimers();
    vi.restoreAllMocks();

    if ((globalThis as any).window) {
      (globalThis as any).window.electronAPI = prevElectronApi;
    }

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir && fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  // ==========================================================================
  // SUITE 1 — Launch & Compatibility Settings UI/UX & WCAG 2.2 AA
  // ==========================================================================
  describe('Suite 1 — Launch & Compatibility Settings UI/UX & WCAG 2.2 AA', () => {
    it('1.1 renders <LaunchSelect>, <SwitchControl> (role="switch", aria-checked), .ol-subgrid-field multi-column rows, Wine Synchronization Mode radio exclusivity, and Dual-OS host parity with 0 WCAG 2.2 AA violations', async () => {
      const cssSource = fs.readFileSync(path.join(REPO_ROOT, 'src/index.css'), 'utf8');
      expect(cssSource).toContain('.ol-subgrid-field');
      expect(cssSource).toContain('grid-template-rows: subgrid');
      expect(cssSource).toContain('.ol-setup-progress:indeterminate');

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-991001',
        steamAppId: 991001,
        title: 'Synthetic Starlight Horizon',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '991001',
            installed: true,
            installPath: '/Users/test/Games/SyntheticStarlightHorizon',
            executablePath: '/Users/test/Games/SyntheticStarlightHorizon/Game.exe',
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      const crossoverLayer: CompatibilityLayerInfo = {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
        appPath: '/Applications/CrossOver.app',
        version: '26.3.0',
        buildVersion: '26.3.0.39832',
        displayVersion: '26.3.0 (Build 39832)',
        d3dmetalVersion: '3.0',
        supportsMetalFxDlssD3dMetal: true,
        availableBottles: ['OneLauncher'],
      };

      let savedPayload: GameLaunchConfig | null = null;
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([crossoverLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([crossoverLayer]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-991001',
        platformId: 'steam',
        platformGameId: '991001',
        title: 'Synthetic Starlight Horizon',
        installPath: '/Users/test/Games/SyntheticStarlightHorizon',
        executablePath: '/Users/test/Games/SyntheticStarlightHorizon/Game.exe',
        executableArchitecture: 'x64',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);
      vi.spyOn(launcherService, 'saveLaunchConfig').mockImplementation(async (cfg) => {
        savedPayload = cfg;
      });

      const modal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });

      let tree = modal.render();
      await Promise.resolve();
      tree = modal.render();

      // Multi-column .ol-subgrid-field wrappers & <LaunchSelect> controls
      const subgridFields = findVNodes(
        tree,
        (n) => typeof n.props?.className === 'string' && n.props.className.includes('ol-subgrid-field')
      );
      expect(subgridFields.length).toBeGreaterThanOrEqual(4);
      expect(findVNodeByTestId(tree, 'compat-runner-select')?.type).toBe('select');
      expect(findVNodeByTestId(tree, 'metalfx-spatial-upscale-select')?.type).toBe('select');
      expect(findVNodeByTestId(tree, 'preferred-max-fps-select')?.type).toBe('select');
      expect(findVNodeByTestId(tree, 'emulate-modeset-select')?.type).toBe('select');

      // <SwitchControl> role="switch" + boolean aria-checked
      const dlssSwitch = findVNodeByTestId(tree, 'toggle-crossover-dlss');
      const metalHudSwitch = findVNodeByTestId(tree, 'toggle-metal-hud');
      const dxvkHudSwitch = findVNodeByTestId(tree, 'toggle-dxvk-hud');
      for (const sw of [dlssSwitch, metalHudSwitch, dxvkHudSwitch]) {
        expect(sw?.type).toBe('button');
        expect(sw?.props?.role).toBe('switch');
        expect(typeof sw?.props?.['aria-checked']).toBe('boolean');
      }

      // Wine Synchronization Mode radio group mutual exclusivity (MSync / ESync / Default)
      const getSyncRadios = (rootTree: any) => {
        const msync = findVNodes(
          findVNodeByTestId(rootTree, 'wine-sync-msync'),
          (n) => n.type === 'input' && n.props?.type === 'radio'
        )[0];
        const esync = findVNodes(
          findVNodeByTestId(rootTree, 'wine-sync-esync'),
          (n) => n.type === 'input' && n.props?.type === 'radio'
        )[0];
        const def = findVNodes(
          findVNodeByTestId(rootTree, 'wine-sync-default'),
          (n) => n.type === 'input' && n.props?.type === 'radio'
        )[0];
        return { msync, esync, def };
      };

      let radios = getSyncRadios(tree);
      expect(radios.msync.props.checked).toBe(true);
      expect(radios.esync.props.checked).toBe(false);
      expect(radios.def.props.checked).toBe(false);

      // Select ESync -> wineEsync=true, wineMsync=false
      radios.esync.props.onChange();
      tree = modal.render();
      radios = getSyncRadios(tree);
      expect(radios.msync.props.checked).toBe(false);
      expect(radios.esync.props.checked).toBe(true);
      expect(radios.def.props.checked).toBe(false);

      // Select Default -> wineMsync=false, wineEsync=false
      radios.def.props.onChange();
      tree = modal.render();
      radios = getSyncRadios(tree);
      expect(radios.msync.props.checked).toBe(false);
      expect(radios.esync.props.checked).toBe(false);
      expect(radios.def.props.checked).toBe(true);

      const saveBtn = findVNodes(
        tree,
        (n) => n.type === 'button' && extractVNodeText(n).includes('Save Configuration')
      )[0];
      await saveBtn.props.onClick();
      expect(savedPayload).toMatchObject({
        gameId: 'steam-991001',
        wineMsync: false,
        wineEsync: false,
      });

      expect(auditWcag22AA(tree)).toEqual([]);
      modal.unmount();

      // Verify Windows (win32) host parity: hides macOS compatibility layer section cleanly with 0 WCAG violations
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      const winModal = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: {
          ...synthGame,
          platforms: [
            {
              ...synthGame.platforms[0],
              installPath: 'C:\\Games\\SyntheticStarlightHorizon',
              executablePath: 'C:\\Games\\SyntheticStarlightHorizon\\Game.exe',
              isWindowsBinaryOnMac: false,
            },
          ],
        },
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      const winTree = winModal.render();
      expect(
        findVNodes(winTree, (n) => n.props?.['data-section'] === 'compatibility-layer-settings').length
      ).toBe(0);
      expect(auditWcag22AA(winTree)).toEqual([]);
      winModal.unmount();
    });

    it('1.2 deduplicates formatRunnerSecondaryBuildText with zero triple version repetition and toggles 32-Bit 4 GB Address Space Override across x64 vs x86 binaries', async () => {
      expect(
        formatRunnerSecondaryBuildText({
          installedVersion: '26.3.0',
          displayVersion: '26.3.0',
        })
      ).toBe('');
      expect(
        formatRunnerSecondaryBuildText({
          installedVersion: '26.3.0',
          buildVersion: '26.3.0.39832',
        })
      ).toBe('Build 39832');
      expect(
        formatRunnerSecondaryBuildText({
          installedVersion: '26.3.0',
          displayVersion: '26.3.0 (Build 39832)',
          buildVersion: '26.3.0.39832',
        })
      ).toBe('Build 39832');
      expect(
        formatRunnerSecondaryBuildText({
          installedVersion: '27.0.0',
          displayVersion: '27.0.0 (Preview 20261006)',
        })
      ).toBe('Preview 20261006');

      const crossoverLayer: CompatibilityLayerInfo = {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
        appPath: '/Applications/CrossOver.app',
        version: '26.3.0',
        buildVersion: '26.3.0.39832',
        displayVersion: '26.3.0 (Build 39832)',
        supportsMetalFxDlssD3dMetal: true,
        availableBottles: ['OneLauncher'],
      };

      const synthGame = makeCanonicalGameFixture({
        id: 'gog-991002',
        title: 'Synthetic Chronos Engine',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '991002',
            installed: true,
            installPath: '/Users/test/Games/SyntheticChronosEngine',
            executablePath: '/Users/test/Games/SyntheticChronosEngine/Chronos.exe',
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([crossoverLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([crossoverLayer]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});

      // Case A: 64-bit PE32+ executable (x64) -> disabled switch + "64-bit Binary — Not Needed"
      const recordSpy = vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'gog-991002',
        platformId: 'gog',
        platformGameId: '991002',
        title: 'Synthetic Chronos Engine',
        installPath: '/Users/test/Games/SyntheticChronosEngine',
        executablePath: '/Users/test/Games/SyntheticChronosEngine/Chronos.exe',
        executableArchitecture: 'x64',
        is32BitExecutable: false,
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      const modal64 = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'gog',
        onClose: vi.fn(),
      });
      let tree64 = modal64.render();
      await Promise.resolve();
      tree64 = modal64.render();

      const versionRowText = extractVNodeText(findVNodeByTestId(tree64, 'runner-installed-version'));
      expect(versionRowText).toContain('v26.3.0 · Build 39832');
      expect((versionRowText.match(/26\.3\.0/g) || []).length).toBe(1);

      const laaSwitch64 = findVNodeByTestId(tree64, 'toggle-force-laa');
      expect(findVNodeByTestId(tree64, 'force-laa-64bit-badge')).toBeDefined();
      expect(laaSwitch64.props.disabled).toBe(true);
      expect(laaSwitch64.props['aria-checked']).toBe(false);
      expect(auditWcag22AA(tree64)).toEqual([]);
      modal64.unmount();

      // Case B: 32-bit PE32 executable (x86) -> enabled switch + interactive toggle
      recordSpy.mockReturnValue({
        id: 'gog-991002',
        platformId: 'gog',
        platformGameId: '991002',
        title: 'Synthetic Chronos Engine',
        installPath: '/Users/test/Games/SyntheticChronosEngine',
        executablePath: '/Users/test/Games/SyntheticChronosEngine/Chronos.exe',
        executableArchitecture: 'x86',
        is32BitExecutable: true,
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      const modal32 = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'gog',
        onClose: vi.fn(),
      });
      let tree32 = modal32.render();
      await Promise.resolve();
      tree32 = modal32.render();

      expect(findVNodeByTestId(tree32, 'force-laa-64bit-badge')).toBeUndefined();
      let laaSwitch32 = findVNodeByTestId(tree32, 'toggle-force-laa');
      expect(laaSwitch32.props.disabled).toBe(false);
      expect(laaSwitch32.props['aria-checked']).toBe(false);

      laaSwitch32.props.onClick();
      tree32 = modal32.render();
      laaSwitch32 = findVNodeByTestId(tree32, 'toggle-force-laa');
      expect(laaSwitch32.props['aria-checked']).toBe(true);
      expect(auditWcag22AA(tree32)).toEqual([]);
      modal32.unmount();
    });

    it('1.3 renders determinate & indeterminate live <progress> states, re-attaches after modal unmount/remount, and cancels background runner operation', async () => {
      let ipcProgressListener: ((evt: CompatibilityRunnerProgressEvent) => void) | null = null;
      const cancelIpcSpy = vi.fn(async (_runnerType: string) => ({
        success: true,
        cancelled: true,
      }));

      (globalThis as any).window.electronAPI = {
        isElectron: true,
        onCompatibilityRunnerProgress: vi.fn((cb: (evt: CompatibilityRunnerProgressEvent) => void) => {
          ipcProgressListener = cb;
          return () => {
            if (ipcProgressListener === cb) ipcProgressListener = null;
          };
        }),
        cancelCompatibilityLayerOperation: cancelIpcSpy,
      };

      const crossoverLayer: CompatibilityLayerInfo = {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
        appPath: '/Applications/CrossOver.app',
        version: '26.3.0',
        supportsMetalFxDlssD3dMetal: true,
        availableBottles: ['OneLauncher'],
      };
      const updatesMap: Record<string, CompatibilityLayerUpdateInfo> = {
        crossover: {
          runnerType: 'crossover',
          installed: true,
          installedVersion: '26.3.0',
          latestVersion: '26.4.0',
          updateAvailable: true,
          canAutoUpdate: true,
          updateMethod: 'direct_download',
          statusMessage: 'Update available: 26.4.0',
          checkedAt: '2026-06-15T12:00:00.000Z',
        },
      };

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([crossoverLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([crossoverLayer]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue(updatesMap);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue(updatesMap);

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-991003',
        steamAppId: 991003,
        title: 'Synthetic Aether Relay',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '991003',
            installed: true,
            installPath: '/Users/test/Games/SyntheticAetherRelay',
            executablePath: '/Users/test/Games/SyntheticAetherRelay/Aether.exe',
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      const modalA = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let treeA = modalA.render();
      await Promise.resolve();
      treeA = modalA.render();
      expect(ipcProgressListener).toBeTypeOf('function');

      // 1. Emit determinate downloading event -> <progress max=100 value=45>
      ipcProgressListener!({
        runnerType: 'crossover',
        operation: 'update',
        phase: 'downloading',
        progressPercent: 45,
        bytesDownloaded: 215 * 1024 * 1024,
        totalBytes: 480 * 1024 * 1024,
        message: 'Downloading CrossOver 26.4.0...',
        updatedAt: '2026-06-15T12:01:00.000Z',
      });
      treeA = modalA.render();

      const detProgress = findVNodeByTestId(treeA, 'runner-operation-progress');
      expect(detProgress).toBeDefined();
      expect(detProgress.props.max).toBe(100);
      expect(detProgress.props.value).toBe(45);
      expect(extractVNodeText(findVNodeByTestId(treeA, 'runner-operation-status'))).toContain('45%');
      expect(auditWcag22AA(treeA)).toEqual([]);

      // 2. Unmount modal while update continues in background (`verifying_signature`), then remount!
      modalA.unmount();

      ipcProgressListener!({
        runnerType: 'crossover',
        operation: 'update',
        phase: 'verifying_signature',
        progressPercent: null,
        message: 'Verifying CodeWeavers Sparkle Ed25519 signature...',
        updatedAt: '2026-06-15T12:01:20.000Z',
      });

      const modalB = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let treeB = modalB.render();
      await Promise.resolve();
      treeB = modalB.render();

      const indetVerifyProgress = findVNodeByTestId(treeB, 'runner-operation-progress');
      expect(indetVerifyProgress).toBeDefined();
      expect(indetVerifyProgress.props.value).toBeUndefined();
      expect(extractVNodeText(findVNodeByTestId(treeB, 'runner-operation-status'))).toContain(
        'Verifying'
      );
      expect(auditWcag22AA(treeB)).toEqual([]);

      // 3. Advance to indeterminate `installing` phase -> value remains undefined
      ipcProgressListener!({
        runnerType: 'crossover',
        operation: 'update',
        phase: 'installing',
        progressPercent: null,
        message: 'Installing CrossOver.app...',
        updatedAt: '2026-06-15T12:01:30.000Z',
      });
      treeB = modalB.render();
      const indetInstallProgress = findVNodeByTestId(treeB, 'runner-operation-progress');
      expect(indetInstallProgress.props.value).toBeUndefined();
      expect(auditWcag22AA(treeB)).toEqual([]);

      // 4. Click Cancel button -> invokes cancelCompatibilityLayerOperation('crossover') and clears panel
      const cancelBtn = findVNodeByTestId(treeB, 'cancel-runner-operation-btn');
      expect(cancelBtn).toBeDefined();
      await cancelBtn.props.onClick();
      expect(cancelIpcSpy).toHaveBeenCalledWith('crossover');

      treeB = modalB.render();
      expect(findVNodeByTestId(treeB, 'runner-live-progress-panel')).toBeUndefined();
      modalB.unmount();
    });

    it('1.4 renders CompatibilityAndBottleStep 4th CrossOver Preview card, update_available switch, and 1-click Apple GPTK auto-install on Apple Silicon with 0 WCAG 2.2 AA violations', () => {
      const macSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover_preview: {
          status: 'update_available',
          version: '27.0.0',
          latestVersion: '27.0.1',
          canAutoInstall: false,
          requiresExternalDownload: true,
        },
        runner_gptk: {
          status: 'missing',
          canAutoInstall: true,
          requiresExternalDownload: false,
        },
      });

      const selectRunnerSpy = vi.fn();
      const toggleRunnerUpdateSpy = vi.fn();
      const selectedSet = new Set<EnvironmentComponentId>(['bottle_default']);

      const stepPreview = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: macSnapshot,
        chosenRunner: 'crossover_preview',
        onSelectRunner: selectRunnerSpy,
        bottleMode: 'reuse_existing',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        gptkDmgPath: '',
        onChangeGptkDmgPath: vi.fn(),
        selectedIds: selectedSet,
        onToggleRunnerUpdate: toggleRunnerUpdateSpy,
      });

      const previewTree = stepPreview.render();
      expect(findVNodeByTestId(previewTree, 'setup-runner-crossover')).toBeDefined();
      expect(findVNodeByTestId(previewTree, 'setup-runner-crossover-preview')).toBeDefined();
      expect(findVNodeByTestId(previewTree, 'setup-runner-wine')).toBeDefined();
      expect(findVNodeByTestId(previewTree, 'setup-runner-gptk')).toBeDefined();
      expect(findVNodeByTestId(previewTree, 'setup-runner-skip')).toBeDefined();

      expect(findVNodeByTestId(previewTree, 'runner-update-badge-crossover-preview')).toBeDefined();
      const previewUpdateSwitch = findVNodeByTestId(
        previewTree,
        'runner-update-toggle-crossover-preview'
      );
      expect(previewUpdateSwitch).toBeDefined();
      expect(previewUpdateSwitch.props.role).toBe('switch');
      expect(previewUpdateSwitch.props['aria-checked']).toBe(false);
      previewUpdateSwitch.props.onClick();
      expect(toggleRunnerUpdateSpy).toHaveBeenCalledWith('runner_crossover_preview', true);
      expect(auditWcag22AA(previewTree)).toEqual([]);
      stepPreview.unmount();

      // Select uninstalled Apple GPTK with blank DMG path -> 1-click auto-install enabled
      const gptkSelectedIds = new Set<EnvironmentComponentId>(['runner_gptk', 'bottle_default']);
      const stepGptk = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: macSnapshot,
        chosenRunner: 'gptk',
        onSelectRunner: selectRunnerSpy,
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        gptkDmgPath: '',
        onChangeGptkDmgPath: vi.fn(),
        selectedIds: gptkSelectedIds,
      });
      const gptkTree = stepGptk.render();
      expect(findVNodeByTestId(gptkTree, 'setup-gptk-dmg-panel')).toBeUndefined();
      expect(extractVNodeText(findVNodeByTestId(gptkTree, 'setup-runner-gptk'))).toContain(
        'Not installed yet — 1-click automatic download & install on Apple Silicon.'
      );
      expect(auditWcag22AA(gptkTree)).toEqual([]);
      stepGptk.unmount();

      const tasks = buildProvisioningTasksFromSelection({
        snapshot: macSnapshot,
        selectedIds: gptkSelectedIds,
        chosenRunner: 'gptk',
        bottleMode: 'create_dedicated',
        bottleName: 'OneLauncher',
        gptkDmgPath: '',
      });
      expect(tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'install_runner',
            componentId: 'runner_gptk',
            runnerType: 'gptk',
          }),
        ])
      );

      // Verify Windows (win32) step parity
      const winStep = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: makeSyntheticSetupSnapshot('win32'),
        chosenRunner: 'skip',
        onSelectRunner: vi.fn(),
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        gptkDmgPath: '',
        onChangeGptkDmgPath: vi.fn(),
      });
      const winStepTree = winStep.render();
      expect(findVNodeByTestId(winStepTree, 'setup-step-compatibility-win32')).toBeDefined();
      expect(auditWcag22AA(winStepTree)).toEqual([]);
      winStep.unmount();
    });

    it('1.5 removes all compact Game Pass tier badges (PCGP, GPU, Ubi+, EA, GP, GPP, GPE) from LibraryGridCard & LibrarySidebar while preserving detail/hover context', () => {
      vi.useFakeTimers();
      const forbiddenCompactTierBadges = new Set(['PCGP', 'GPU', 'Ubi+', 'EA', 'GP', 'GPP', 'GPE']);

      const subscriptionGames: CanonicalGame[] = [
        makeCanonicalGameFixture({
          id: 'xbox-9NSYNTHPCGP1',
          title: 'Synthetic Astral Relay',
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: '9NSYNTHPCGP1',
              xboxProductId: '9NSYNTHPCGP1',
              ownershipType: 'subscription',
              subscriptionExpired: false,
              installed: false,
            },
          ],
        }),
        makeCanonicalGameFixture({
          id: 'xbox-9NSYNTHEAPLY',
          title: 'Synthetic Velocity Arena',
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: '9NSYNTHEAPLY',
              xboxProductId: '9NSYNTHEAPLY',
              ownershipType: 'subscription',
              chainedLauncherHandoff: 'ea_app',
              subscriptionExpired: false,
              installed: false,
            },
          ],
        }),
        makeCanonicalGameFixture({
          id: 'xbox-9NSYNTHUBICL',
          title: 'Synthetic Citadel Origins',
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: '9NSYNTHUBICL',
              xboxProductId: '9NSYNTHUBICL',
              ownershipType: 'subscription',
              chainedLauncherHandoff: 'ubisoft_connect',
              subscriptionExpired: false,
              installed: false,
            },
          ],
        }),
      ];

      // 1. LibraryGridView (LibraryGridCard)
      const grid = createDomain12DeepRenderer(LibraryGridView, {
        games: subscriptionGames,
        onSelectGame: () => {},
        connectedStorefronts: ['xbox'],
      });
      const gridTree = grid.render();
      const cardBadgeMatches = findElements(gridTree, (el) => {
        if (el.type !== 'div' && el.type !== 'span') return false;
        return forbiddenCompactTierBadges.has(getTextContent(el).trim());
      });
      expect(cardBadgeMatches).toEqual([]);

      // Hover popout still shows GP context
      const firstCard = findElements(
        gridTree,
        (el) => el.props?.['data-game-id'] === 'xbox-9NSYNTHPCGP1'
      )[0];
      firstCard.props.onMouseEnter({
        currentTarget: {
          getBoundingClientRect: () => ({
            left: 100,
            right: 300,
            top: 100,
            bottom: 400,
            width: 200,
            height: 300,
          }),
          contains: () => false,
        },
      });
      vi.advanceTimersByTime(600);
      const hoveredTree = grid.render();
      expect(
        findElements(hoveredTree, (el) => el.type === 'span' && getTextContent(el).trim() === 'GP')
          .length
      ).toBeGreaterThan(0);
      grid.unmount();

      // 2. LibrarySidebar rows
      const sidebar = createDomain12DeepRenderer(LibrarySidebar, {
        games: subscriptionGames,
        selectedGameId: null,
        onSelectGame: () => {},
        searchQuery: '',
        onSearchChange: () => {},
        selectedPlatform: 'all',
        onSelectPlatform: () => {},
        installedOnly: false,
        onToggleInstalledOnly: () => {},
        collections: [],
        onOpenManageCollectionsModal: () => {},
        onToggleGameInCollection: () => {},
        connectedStorefronts: ['xbox'],
      });
      const sidebarTree = sidebar.render();
      const sidebarBadgeMatches = findElements(sidebarTree, (el) => {
        if (el.type !== 'span' && el.type !== 'div') return false;
        return forbiddenCompactTierBadges.has(getTextContent(el).trim());
      });
      expect(sidebarBadgeMatches).toEqual([]);
      sidebar.unmount();

      // 3. PlatformBadges detail view retains Game Pass context
      const detailBadges = createDomain12DeepRenderer(PlatformBadges, {
        platforms: subscriptionGames[0].platforms,
        gameTitle: subscriptionGames[0].title,
        connectedStorefronts: ['xbox'] as StorefrontId[],
      });
      const detailTree = detailBadges.render();
      expect(getTextContent(detailTree)).toMatch(/Game Pass|GP/);
      detailBadges.unmount();
    });
  });

  // ==========================================================================
  // SUITE 2 — Background Runner Downloader, Ed25519/SHA-256 Verifier, Busy Guard & Atomic Swap
  // ==========================================================================
  describe('Suite 2 — Background Runner Downloader, Ed25519/SHA-256 Verifier, Busy Guard & Atomic Swap (darwin + win32 safe)', () => {
    it('2.1 verifies valid Sparkle Ed25519 signatures and rejects + unlinks 1-byte tampered payloads using a real node:crypto Ed25519 keypair', async () => {
      const dir = makeTempDir('ed25519');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const spkiDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
      const rawPubKey32B64 = spkiDer.subarray(spkiDer.length - 32).toString('base64');

      const archivePayload = Buffer.from(
        'PK\x03\x04SYNTHETIC-CROSSOVER-ARCHIVE-BINARY-PAYLOAD-V26.4.0',
        'utf8'
      );
      const signatureB64 = crypto.sign(null, archivePayload, privateKey).toString('base64');

      const validArchivePath = path.join(dir, 'CrossOver-26.4.0-valid.zip');
      fs.writeFileSync(validArchivePath, archivePayload);

      await expect(
        environmentProvisioner.verifySparkleEd25519SignatureAsync(
          validArchivePath,
          signatureB64,
          rawPubKey32B64
        )
      ).resolves.toBeUndefined();
      expect(fs.existsSync(validArchivePath)).toBe(true);

      // Flip 1 byte in payload -> must reject AND immediately unlink tampered archive
      const tamperedPayload = Buffer.from(archivePayload);
      tamperedPayload[12] ^= 0xff;
      const tamperedArchivePath = path.join(dir, 'CrossOver-26.4.0-tampered.zip');
      fs.writeFileSync(tamperedArchivePath, tamperedPayload);

      await expect(
        environmentProvisioner.verifySparkleEd25519SignatureAsync(
          tamperedArchivePath,
          signatureB64,
          rawPubKey32B64
        )
      ).rejects.toThrow(/Sparkle Ed25519 verification failed/);
      expect(fs.existsSync(tamperedArchivePath)).toBe(false);
    });

    it('2.2 blocks runner replacement with RUNNER_BUSY_ACTIVE_SESSION and RUNNER_BUSY_EXTERNAL_PROCESS when sessions or external GUI processes are active', async () => {
      const dir = makeTempDir('busy-guard');
      const appsDir = path.join(dir, 'Applications');
      const appPath = seedSyntheticCrossOverApp(appsDir, 'CrossOver.app', '26.3.0', '26.3.0.39832');
      const layer = {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        appPath,
        binaryPath: path.join(appPath, 'Contents/SharedSupport/CrossOver/bin/wine'),
        wineserverBinary: path.join(appPath, 'Contents/SharedSupport/CrossOver/bin/wineserver'),
      };

      // 1. Active bottled session in activeSessions -> RUNNER_BUSY_ACTIVE_SESSION (darwin & win32)
      engineStateRegistry.activeSessions.set('steam-992001', {
        finalized: false,
        compatibilityLayer: 'crossover',
        wineBinary: layer.binaryPath,
        session: {
          gameId: 'steam-992001',
          title: 'Synthetic Nebula Vanguard',
          compatibilityLayer: 'crossover',
        },
      });

      for (const hostPlatform of ['darwin', 'win32'] as const) {
        const busySessionRes = await environmentProvisioner.assertRunnerSafeToReplace(
          'crossover',
          appPath,
          layer,
          { platform: hostPlatform }
        );
        expect(busySessionRes).toMatchObject({
          ok: false,
          busyCode: 'RUNNER_BUSY_ACTIVE_SESSION',
        });
        expect(busySessionRes.error).toContain('Synthetic Nebula Vanguard');
      }

      engineStateRegistry.activeSessions.clear();

      // 2. External CrossOver GUI process active -> RUNNER_BUSY_EXTERNAL_PROCESS
      const psGuiOutput = `  42424 ${appPath}/Contents/MacOS/CrossOver -psn_0_12345\n`;
      const busyGuiRes = await environmentProvisioner.assertRunnerSafeToReplace(
        'crossover',
        appPath,
        layer,
        {
          platform: 'darwin',
          mockProcessListOutput: psGuiOutput,
        }
      );
      expect(busyGuiRes).toMatchObject({
        ok: false,
        busyCode: 'RUNNER_BUSY_EXTERNAL_PROCESS',
      });
      expect(busyGuiRes.error).toContain('Please quit CrossOver');

      // 3. Only idle wineserver daemon that exits cleanly on shutdown -> ok: true
      let psCalls = 0;
      const idleSafeRes = await environmentProvisioner.assertRunnerSafeToReplace(
        'crossover',
        appPath,
        layer,
        {
          platform: 'darwin',
          homedir: path.join(dir, 'home'),
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, '', ''),
          getProcessListOutput: async () => {
            psCalls += 1;
            return psCalls === 1
              ? `  51515 ${appPath}/Contents/SharedSupport/CrossOver/bin/wineserver\n`
              : '';
          },
        }
      );
      expect(idleSafeRes).toEqual({ ok: true });
    });

    it('2.3 atomically swaps macOS .app bundles and rolls back from .ol-backup when final rename fails, leaving original .app intact', async () => {
      const dir = makeTempDir('atomic-swap');
      const targetAppsDir = path.join(dir, 'Applications');
      const stagingRoot = path.join(dir, 'staging');
      const existingApp = seedSyntheticCrossOverApp(
        targetAppsDir,
        'CrossOver.app',
        '26.2.0',
        '26.2.0.39001'
      );
      const stagedNewApp = seedSyntheticCrossOverApp(
        stagingRoot,
        'CrossOver.app',
        '26.4.0',
        '26.4.0.40100'
      );

      const readShortVer = (p: string) =>
        fs.readFileSync(path.join(p, 'Contents/Info.plist'), 'utf8');

      // Simulate failure on the swap rename(siblingStagingPath -> targetDestAppPath)
      const realRename = fs.promises.rename.bind(fs.promises);
      const renameSpy = vi
        .spyOn(fs.promises, 'rename')
        .mockImplementation(async (oldPath, newPath) => {
          const oldStr = String(oldPath);
          const newStr = String(newPath);
          if (oldStr.includes('.ol-staging-') && newStr === existingApp) {
            throw Object.assign(new Error('Simulated EXDEV/EIO rename failure during swap'), {
              code: 'EIO',
            });
          }
          return realRename(oldPath, newPath);
        });

      await expect(
        environmentProvisioner.atomicReplaceMacAppBundle(stagedNewApp, existingApp, {
          skipStagingCodesignVerify: true,
          onExecDitto: async (src: string, dest: string) => {
            await fs.promises.cp(src, dest, { recursive: true, force: true });
          },
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, '', ''),
        })
      ).rejects.toThrow(/Simulated EXDEV\/EIO rename failure/);

      renameSpy.mockRestore();

      // Original v26.2.0 .app MUST remain intact and zero .ol-backup / .ol-staging folders may remain
      expect(fs.existsSync(existingApp)).toBe(true);
      expect(readShortVer(existingApp)).toContain('<string>26.2.0</string>');
      const leftoverAfterRollback = fs
        .readdirSync(targetAppsDir)
        .filter((n) => n.includes('.ol-backup-') || n.includes('.ol-staging-'));
      expect(leftoverAfterRollback).toEqual([]);

      // Now run normal atomic swap -> upgrades cleanly to v26.4.0
      const swappedPath = await environmentProvisioner.atomicReplaceMacAppBundle(
        stagedNewApp,
        existingApp,
        {
          skipStagingCodesignVerify: true,
          onExecDitto: async (src: string, dest: string) => {
            await fs.promises.cp(src, dest, { recursive: true, force: true });
          },
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, '', ''),
        }
      );
      expect(swappedPath).toBe(existingApp);
      expect(readShortVer(existingApp)).toContain('<string>26.4.0</string>');
      const leftoverAfterSwap = fs
        .readdirSync(targetAppsDir)
        .filter((n) => n.includes('.ol-backup-') || n.includes('.ol-staging-'));
      expect(leftoverAfterSwap).toEqual([]);
    });

    it('2.4 executes background updateCompatibilityLayer (download -> Ed25519/SHA-256 verify -> extract -> atomic install), deduplicates single-flight calls, cancels in-flight downloads, picks higher /Applications vs ~/Applications version, and enforces validateOptionalRunnerArchivePath IPC security', async () => {
      const dir = makeTempDir('bg-updater');
      const homedir = path.join(dir, 'Users', 'test');
      const sysAppsDir = path.join(dir, 'SystemApplications');
      const userAppsDir = path.join(homedir, 'Applications');
      fs.mkdirSync(sysAppsDir, { recursive: true });
      fs.mkdirSync(userAppsDir, { recursive: true });

      // 1. /Applications vs ~/Applications higher-version selection in detectCompatibilityLayers
      seedSyntheticCrossOverApp(sysAppsDir, 'CrossOver.app', '26.1.0', '26.1.0.38000');
      const userCrossOverPath = seedSyntheticCrossOverApp(
        userAppsDir,
        'CrossOver.app',
        '26.3.0',
        '26.3.0.39832'
      );

      const detected = macNativeInstaller.detectCompatibilityLayers({
        platform: 'darwin',
        arch: 'arm64',
        homedir,
        applicationsDirs: [sysAppsDir, userAppsDir],
      });
      const detectedCrossOver = detected.find((l: any) => l.type === 'crossover');
      expect(detectedCrossOver).toBeDefined();
      expect(detectedCrossOver.version).toBe('26.3.0');
      expect(detectedCrossOver.appPath).toBe(userCrossOverPath);

      // Also verify reverse: when /Applications has 26.5.0 > ~/Applications 26.3.0, /Applications wins
      const sysAppsDirHigher = path.join(dir, 'SystemApplicationsHigher');
      const sysHigherPath = seedSyntheticCrossOverApp(
        sysAppsDirHigher,
        'CrossOver.app',
        '26.5.0',
        '26.5.0.41000'
      );
      const detectedSysHigher = macNativeInstaller.detectCompatibilityLayers({
        platform: 'darwin',
        arch: 'arm64',
        homedir,
        applicationsDirs: [userAppsDir, sysAppsDirHigher],
      });
      expect(detectedSysHigher.find((l: any) => l.type === 'crossover')?.appPath).toBe(
        sysHigherPath
      );

      // 2. End-to-end background updateCompatibilityLayer + single-flight deduplication + phase progression
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const spkiDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
      const pubB64 = spkiDer.subarray(spkiDer.length - 32).toString('base64');

      const archiveBytes = Buffer.from('PK\x03\x04SYNTHETIC-CROSSOVER-26.4.0-ZIP-ARCHIVE-BYTES');
      const archiveSha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex');
      const archiveEdSig = crypto.sign(null, archiveBytes, privateKey).toString('base64');
      const archiveUrl = 'https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-26.4.0.zip';

      const sparkleXml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <item>
      <title>CrossOver 26.4.0</title>
      <enclosure url="${archiveUrl}"
                 sparkle:version="26.4.0.40210"
                 sparkle:shortVersionString="26.4.0"
                 sparkle:edSignature="${archiveEdSig}"
                 length="${archiveBytes.length}"
                 type="application/octet-stream" />
    </item>
  </channel>
</rss>`;

      const caskJson = JSON.stringify({
        token: 'crossover',
        version: '26.4.0,40210',
        url: archiveUrl,
        sha256: archiveSha256,
      });

      let zipDownloadCount = 0;
      const recordedPhases: string[] = [];

      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('cxmac.xml')) {
          return {
            ok: true,
            status: 200,
            text: async () => sparkleXml,
          };
        }
        if (url.includes('formulae.brew.sh/api/cask/crossover.json')) {
          return {
            ok: true,
            status: 200,
            text: async () => caskJson,
            json: async () => JSON.parse(caskJson),
          };
        }
        if (url === archiveUrl) {
          zipDownloadCount += 1;
          await new Promise((r) => setTimeout(r, 15));
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(archiveBytes));
              controller.close();
            },
          });
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h: string) =>
                h.toLowerCase() === 'content-length' ? String(archiveBytes.length) : null,
            },
            body: stream,
          };
        }
        throw new Error(`Unexpected URL in updateCompatibilityLayer test: ${url}`);
      });

      const updateOpts = {
        platform: 'darwin',
        arch: 'arm64',
        homedir,
        applicationsDirs: [userAppsDir],
        customApplicationsDir: userAppsDir,
        allowDirectVendorInstall: true,
        sparklePublicEdKey: pubB64,
        freeDiskBytes: 20 * 1024 * 1024 * 1024,
        skipProcessCheck: true,
        skipStagingCodesignVerify: true,
        fetchFn,
        fetchImpl: fetchFn,
        verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
        onExtractArchive: async (_zipPath: string, stagingDir: string) => {
          seedSyntheticCrossOverApp(stagingDir, 'CrossOver.app', '26.4.0', '26.4.0.40210');
        },
        onExecDitto: async (src: string, dest: string) => {
          await fs.promises.cp(src, dest, { recursive: true, force: true });
        },
        execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, '', ''),
        onRunnerProgress: (evt: CompatibilityRunnerProgressEvent) => {
          if (recordedPhases[recordedPhases.length - 1] !== evt.phase) {
            recordedPhases.push(evt.phase);
          }
        },
      };

      const [res1, res2] = await Promise.all([
        macNativeInstaller.updateCompatibilityLayer({ runnerType: 'crossover' }, updateOpts),
        macNativeInstaller.updateCompatibilityLayer({ runnerType: 'crossover' }, updateOpts),
      ]);

      expect(zipDownloadCount).toBe(1);
      expect(res1).toMatchObject({
        success: true,
        updated: true,
        previousVersion: '26.3.0',
        newVersion: '26.4.0',
      });
      expect(res2).toEqual(res1);
      expect(recordedPhases).toEqual([
        'probing',
        'downloading',
        'verifying_signature',
        'extracting',
        'verifying_signature',
        'installing',
        'completed',
      ]);

      // 3. Cancellation of an in-flight runner download via cancelCompatibilityLayerOperation
      const cancelPhases: string[] = [];
      let notifyDownloadStarted!: () => void;
      const downloadStartedPromise = new Promise<void>((resolve) => {
        notifyDownloadStarted = resolve;
      });

      const slowWineArchiveUrl =
        'https://github.com/Gcenx/macOS_Wine_builds/releases/download/10.0/wine-stable-10.0-osx64.tar.xz';
      const wineCaskJson = JSON.stringify({
        token: 'wine-stable',
        version: '10.0',
        url: slowWineArchiveUrl,
        sha256: 'a'.repeat(64),
      });

      const slowFetchFn = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
        if (url.includes('wine-stable.json')) {
          return {
            ok: true,
            status: 200,
            text: async () => wineCaskJson,
            json: async () => JSON.parse(wineCaskJson),
          };
        }
        const sig = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024));
            notifyDownloadStarted();
            sig?.addEventListener(
              'abort',
              () => {
                const abortErr = new Error('The operation was aborted.');
                abortErr.name = 'AbortError';
                controller.error(abortErr);
              },
              { once: true }
            );
          },
        });
        return {
          ok: true,
          status: 200,
          headers: {
            get: (h: string) => (h.toLowerCase() === 'content-length' ? String(50 * 1024 * 1024) : null),
          },
          body,
        };
      });

      const inFlightWinePromise = macNativeInstaller.updateCompatibilityLayer(
        { runnerType: 'wine' },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          applicationsDirs: [userAppsDir],
          customApplicationsDir: userAppsDir,
          allowDirectVendorInstall: true,
          freeDiskBytes: 20 * 1024 * 1024 * 1024,
          skipProcessCheck: true,
          fetchFn: slowFetchFn,
          fetchImpl: slowFetchFn,
          onRunnerProgress: (evt: CompatibilityRunnerProgressEvent) => {
            cancelPhases.push(evt.phase);
          },
        }
      );

      await downloadStartedPromise;
      const cancelRes = macNativeInstaller.cancelCompatibilityLayerOperation('wine');
      expect(cancelRes).toEqual({ success: true, cancelled: true });

      const abortedOutcome = await inFlightWinePromise;
      expect(abortedOutcome).toMatchObject({
        success: false,
        cancelled: true,
        runnerType: 'wine',
        updated: false,
      });
      expect(cancelPhases).toContain('cancelled');

      // 4. IPC Security: validateOptionalRunnerArchivePath & sanitizeCompatLayerPayload rejections
      const unsafeArchiveInputs = [
        '/Users/test/Downloads/CrossOver\0.zip',
        '/Users/test/Downloads/../etc/CrossOver.zip',
        '-rf.zip',
        '/Users/test/Downloads/-dashFlag.dmg',
        'relative/path/CrossOver.zip',
        '/Users/test/Downloads/malicious.sh',
        '/Users/test/Downloads/installer.pkg',
      ];
      for (const badInput of unsafeArchiveInputs) {
        expect(
          launcherIpcHandlers.validateOptionalRunnerArchivePath(badInput).ok,
          `Expected archivePath "${badInput}" to be rejected`
        ).toBe(false);
        expect(
          launcherIpcHandlers.sanitizeCompatLayerPayload(
            { runnerType: 'crossover', archivePath: badInput },
            'update'
          ).ok
        ).toBe(false);
      }

      for (const validExt of ['.zip', '.dmg', '.tar.xz', '.txz']) {
        const safePath = path.join(dir, `RunnerRelease${validExt}`);
        const check = launcherIpcHandlers.validateOptionalRunnerArchivePath(safePath);
        expect(check).toEqual({ ok: true, value: safePath });
      }
    });
  });

  // ==========================================================================
  // SUITE 3 — Xbox Uninstalled "Expired" Ghost Pruning & Rolling passGrants Re-Hydration
  // ==========================================================================
  describe('Suite 3 — Xbox Uninstalled "Expired" Ghost Pruning & DisplayCatalog Rolling passGrants Cache Re-Hydration', () => {
    it('3.1 clears p.version across all uninstall reconciliation layers and prunes uninstalled lapsed subscription titles while retaining genuinely locally installed lapsed titles with subscriptionExpired: true', () => {
      const previouslyInstalledSubGame = makeCanonicalGameFixture({
        id: 'xbox-9NSYNTHQDRFT',
        title: 'Synthetic Quantum Drift',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NSYNTHQDRFT',
            xboxProductId: '9NSYNTHQDRFT',
            packageFamilyName: 'SyntheticStudio.9NSYNTHQDRFT_8wekyb3d8bbwe',
            ownershipType: 'subscription',
            subscriptionExpired: false,
            installed: true,
            installPath: '/Users/test/Games/Xbox/SyntheticQuantumDrift',
            executablePath: '/Users/test/Games/Xbox/SyntheticQuantumDrift/QuantumDrift.exe',
            installSize: 16_000_000_000,
            version: '1.4.2.0',
          },
        ],
      });

      // Layer A: reconcileCatalogGamesWithInstalledRecords clears installed, paths, size, AND version
      const recGames = reconcileCatalogGamesWithInstalledRecords(
        [previouslyInstalledSubGame],
        [],
        { authoritativeRemoval: true }
      );
      expect(recGames[0]).not.toBe(previouslyInstalledSubGame);
      expect(recGames[0].platforms[0].installed).toBe(false);
      expect(recGames[0].platforms[0].installPath).toBeUndefined();
      expect(recGames[0].platforms[0].executablePath).toBeUndefined();
      expect(recGames[0].platforms[0].installSize).toBeUndefined();
      expect(recGames[0].platforms[0].version).toBeUndefined();

      // Layer B: mergeUpdatedGamePreservingLivePlatformState does NOT resurrect stale version onto uninstalled live entry
      const staleMetadataUpdate: CanonicalGame = {
        ...previouslyInstalledSubGame,
        platforms: [
          {
            ...previouslyInstalledSubGame.platforms[0],
            installed: false,
            installPath: undefined,
            executablePath: undefined,
            version: '1.4.2.0',
          },
        ],
      };
      const mergedLive = mergeUpdatedGamePreservingLivePlatformState(
        recGames[0],
        staleMetadataUpdate
      );
      expect(mergedLive.platforms[0].installed).toBe(false);
      expect(mergedLive.platforms[0].version).toBeUndefined();

      // Layer C: reconcileLocalInstallationsPure clears version when authoritativeScanSucceeded = true and record is uninstalled
      const pureSyncRes = reconcileLocalInstallationsPure(
        [previouslyInstalledSubGame],
        [],
        [],
        new Set<number>(),
        true,
        {}
      );
      expect(pureSyncRes.changed).toBe(true);
      expect(pureSyncRes.nextGames[0].platforms[0].installed).toBe(false);
      expect(pureSyncRes.nextGames[0].platforms[0].installPath).toBeUndefined();
      expect(pureSyncRes.nextGames[0].platforms[0].executablePath).toBeUndefined();
      expect(pureSyncRes.nextGames[0].platforms[0].installSize).toBeUndefined();
      expect(pureSyncRes.nextGames[0].platforms[0].version).toBeUndefined();

      // Authoritative mergeStorefrontGames when title rotates out of Game Pass:
      //  - Uninstalled `Synthetic Quantum Drift` MUST be pruned completely (0 "Expired" ghost)
      //  - Genuinely locally installed `Synthetic Chrono Protocol` MUST be retained with `subscriptionExpired: true`
      const genuinelyInstalledLapsedGame = makeCanonicalGameFixture({
        id: 'xbox-9NSYNTHCHRON',
        title: 'Synthetic Chrono Protocol',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NSYNTHCHRON',
            xboxProductId: '9NSYNTHCHRON',
            ownershipType: 'subscription',
            subscriptionExpired: false,
            installed: true,
            installPath: '/Users/test/Games/Xbox/SyntheticChronoProtocol',
            executablePath: '/Users/test/Games/Xbox/SyntheticChronoProtocol/Chrono.exe',
            installSize: 22_000_000_000,
            version: '2.1.0.0',
          },
        ],
      });

      const activeSyncedGame = makeCanonicalGameFixture({
        id: 'xbox-9NSYNTHACTIV',
        title: 'Synthetic Active Odyssey',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NSYNTHACTIV',
            xboxProductId: '9NSYNTHACTIV',
            ownershipType: 'subscription',
            subscriptionExpired: false,
            installed: false,
          },
        ],
      });

      const catalogBeforeSync = [pureSyncRes.nextGames[0], genuinelyInstalledLapsedGame];
      const afterAuthoritativeMerge = mergeStorefrontGames(
        catalogBeforeSync,
        [activeSyncedGame],
        'xbox',
        { authoritativeComplete: true }
      );

      expect(afterAuthoritativeMerge.find((g) => g.id === 'xbox-9NSYNTHQDRFT')).toBeUndefined();

      const retainedInstalledLapsed = afterAuthoritativeMerge.find(
        (g) => g.id === 'xbox-9NSYNTHCHRON'
      );
      expect(retainedInstalledLapsed).toBeDefined();
      expect(retainedInstalledLapsed!.platforms[0]).toMatchObject({
        installed: true,
        ownershipType: 'subscription',
        subscriptionExpired: true,
      });
    });

    it('3.2 purges already-poisoned uninstalled subscriptionExpired: true ghosts (including cross-matched steam-999101) during startup self-heal across sanitizeGameCatalog, hydrateCatalogFromIndexedDb, and SQLite OfflineVaultService', async () => {
      const poisonedStandaloneXboxGhost = makeCanonicalGameFixture({
        id: 'xbox-9NSYNTHGHOST',
        title: 'Synthetic Orbit Odyssey',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NSYNTHGHOST',
            xboxProductId: '9NSYNTHGHOST',
            ownershipType: 'subscription',
            subscriptionExpired: true,
            installed: false,
            // Leftover version from pre-fix uninstall that previously tricked retention!
            version: '1.0.8.0',
          },
        ],
      });

      const poisonedCrossMatchedCanonicalGhost = makeCanonicalGameFixture({
        id: 'steam-999101',
        steamAppId: 999101,
        title: 'Synthetic Starforge Tactics',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NSYNTHSTFG1',
            xboxProductId: '9NSYNTHSTFG1',
            ownershipType: 'subscription',
            subscriptionExpired: true,
            installed: false,
            version: '1.2.0.0',
          },
        ],
      });

      const dualOwnedWithPoisonedXbox = makeCanonicalGameFixture({
        id: 'steam-999102',
        steamAppId: 999102,
        title: 'Synthetic Dual Horizon',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '999102',
            ownershipType: 'owned',
            installed: false,
          },
          {
            platformId: 'xbox',
            platformGameId: '9NSYNTHDUAL2',
            xboxProductId: '9NSYNTHDUAL2',
            ownershipType: 'subscription',
            subscriptionExpired: true,
            installed: false,
            version: '1.0.0.0',
          },
        ],
      });

      recordVerifiedUserEntitlements('xbox', [
        poisonedStandaloneXboxGhost,
        poisonedCrossMatchedCanonicalGhost,
      ]);
      recordVerifiedUserEntitlements('steam', [dualOwnedWithPoisonedXbox]);

      // 1. sanitizeGameCatalog immediately drops xbox-9NSYNTHGHOST & steam-999101 and strips poisoned xbox from steam-999102
      const sanitized = sanitizeGameCatalog(
        [
          poisonedStandaloneXboxGhost,
          poisonedCrossMatchedCanonicalGhost,
          dualOwnedWithPoisonedXbox,
        ],
        { allowNewPurchases: true }
      );
      expect(sanitized.map((g) => g.id)).toEqual(['steam-999102']);
      expect(sanitized[0].platforms.map((p) => p.platformId)).toEqual(['steam']);

      // 2. hydrateCatalogFromIndexedDb self-heals poisoned IndexedDB catalog and deletes dropped IDs from offlineVault
      hoisted.idbStore.set(IDB_KEY_MAIN_CATALOG, [
        poisonedStandaloneXboxGhost,
        poisonedCrossMatchedCanonicalGhost,
        dualOwnedWithPoisonedXbox,
      ]);
      const deleteGamesSpy = vi.fn(async (ids: string[]) => ({
        success: true,
        deletedCount: ids.length,
      }));
      (globalThis as any).window.electronAPI = {
        isElectron: true,
        offlineVault: {
          getCatalogSnapshot: vi.fn(async () => ({
            success: true,
            games: [
              poisonedStandaloneXboxGhost,
              poisonedCrossMatchedCanonicalGhost,
              dualOwnedWithPoisonedXbox,
            ],
          })),
          deleteGames: deleteGamesSpy,
        },
      };

      const hydrated = await hydrateCatalogFromIndexedDb();
      flushPendingCatalogSave();
      expect(hydrated).not.toBeNull();
      expect(hydrated!.map((g) => g.id)).toEqual(['steam-999102']);
      expect(hydrated![0].platforms.map((p) => p.platformId)).toEqual(['steam']);
      expect(deleteGamesSpy).toHaveBeenCalledWith(
        expect.arrayContaining(['xbox-9NSYNTHGHOST', 'steam-999101'])
      );

      // 3. Real SQLite OfflineVaultService (`runStartupSelfHeal` + `getCatalogSnapshot`) purges poisoned rows from vault_games
      const vaultDir = makeTempDir('offline-vault-heal');
      const vault = new offlineVaultMod.OfflineVaultService({ userDataDir: vaultDir });
      try {
        const db = vault.ensureOpen();
        const insertStmt = db.prepare(`
          INSERT INTO vault_games (
            game_id, canonical_title, steam_app_id, is_installed, is_favorited,
            archived_by_subscription_rotation, platforms_json, summary_json,
            metadata_quality, updated_at
          ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, 'storefront_native', ?)
        `);
        const nowTs = Date.now();
        insertStmt.run(
          'xbox-9NSYNTHGHOST',
          'Synthetic Orbit Odyssey',
          null,
          0,
          JSON.stringify(poisonedStandaloneXboxGhost.platforms),
          JSON.stringify(poisonedStandaloneXboxGhost),
          nowTs
        );
        insertStmt.run(
          'steam-999101',
          'Synthetic Starforge Tactics',
          999101,
          0,
          JSON.stringify(poisonedCrossMatchedCanonicalGhost.platforms),
          JSON.stringify(poisonedCrossMatchedCanonicalGhost),
          nowTs
        );
        insertStmt.run(
          'steam-999102',
          'Synthetic Dual Horizon',
          999102,
          0,
          JSON.stringify(dualOwnedWithPoisonedXbox.platforms),
          JSON.stringify(dualOwnedWithPoisonedXbox),
          nowTs
        );

        // Cold-restart OfflineVaultService -> runStartupSelfHeal + getCatalogSnapshot purge orphaned rows from SQLite!
        vault.shutdown();
        const reopenedVault = new offlineVaultMod.OfflineVaultService({ userDataDir: vaultDir });
        try {
          const snapshot = reopenedVault.getCatalogSnapshot();
          expect(snapshot.games.map((g: any) => g.id)).toEqual(['steam-999102']);
          expect(snapshot.games[0].platforms.map((p: any) => p.platformId)).toEqual(['steam']);

          const remainingDbIds = reopenedVault
            .ensureOpen()
            .prepare('SELECT game_id FROM vault_games ORDER BY game_id ASC')
            .all()
            .map((r: any) => r.game_id);
          expect(remainingDbIds).toEqual(['steam-999102']);
        } finally {
          reopenedVault.shutdown();
        }
      } finally {
        vault.shutdown();
      }
    });

    it('3.3 detects rolled-over DisplayCatalog passGrants[] in SQLite cache via hasStaleCachedDesktopPassGrants and automatically re-fetches live DisplayCatalog in syncXboxCatalog instead of dropping or expiring active PC Game Pass titles', async () => {
      const { hasStaleCachedDesktopPassGrants, syncXboxCatalog, GAMEPASS_SIGL_IDS } =
        xboxCatalogAndGamePass;

      const t0Ms = Date.parse('2026-05-01T12:00:00.000Z');
      const rolledOverMs = Date.parse('2026-06-15T12:00:00.000Z');

      // Direct unit assertions on hasStaleCachedDesktopPassGrants
      const compactRollingProd = {
        _compactV3: true,
        _compactDesktopLicensing: {
          hasRawLicensingData: true,
          hasUnconditionalDesktopFulfill: false,
          passGrants: [
            {
              passId: 'CFQ7TTC0KGQ8',
              start: '2025-06-01T00:00:00.000Z',
              end: '2026-06-01T00:00:00.000Z',
            },
          ],
        },
      };
      expect(hasStaleCachedDesktopPassGrants(compactRollingProd, t0Ms)).toBe(false);
      expect(hasStaleCachedDesktopPassGrants(compactRollingProd, rolledOverMs)).toBe(true);
      expect(
        hasStaleCachedDesktopPassGrants(
          {
            _compactV3: true,
            _compactDesktopLicensing: {
              hasRawLicensingData: true,
              hasUnconditionalDesktopFulfill: false,
              passGrants: [
                {
                  passId: 'CFQ7TTC0KGQ8',
                  start: '2025-06-01T00:00:00.000Z',
                  end: '2026-06-01T00:00:00.000Z',
                },
                {
                  passId: 'CFQ7TTC0KGQ8',
                  start: '2026-06-01T00:00:00.000Z',
                  end: '2027-06-01T00:00:00.000Z',
                },
              ],
            },
          },
          rolledOverMs
        )
      ).toBe(false);
      expect(
        hasStaleCachedDesktopPassGrants(
          {
            _compactV3: true,
            _compactDesktopLicensing: {
              hasRawLicensingData: true,
              hasUnconditionalDesktopFulfill: true,
              passGrants: [
                {
                  passId: 'CFQ7TTC0KGQ8',
                  start: '2025-06-01T00:00:00.000Z',
                  end: '2026-06-01T00:00:00.000Z',
                },
              ],
            },
          },
          rolledOverMs
        )
      ).toBe(false);

      // End-to-end SQLite xbox_catalog_cache_v1.sqlite + syncXboxCatalog rolling window proof
      const cacheUserDataDir = makeTempDir('xbox-rolling-passgrants');
      const ROLLING_BIG_ID = '9NSYNTHROLL1';
      let currentDisplayCatalogEndIso = '2026-06-01T00:00:00.000Z';
      let displayCatalogFetchCount = 0;

      const fetchImpl = vi.fn(async (rawUrl: string, init?: any) => {
        const parsed = new URL(String(rawUrl));

        if (parsed.hostname === 'beige.xboxservices.com') {
          if (parsed.pathname.endsWith('/PCGAFD/entitlements/subscriptions')) {
            return jsonHttpResponse({
              subscriptions: [
                {
                  productId: 'CFQ7TTC0KGQ8',
                  status: 'Active',
                  autoRenew: true,
                  endDate: '2028-01-01T00:00:00.000Z',
                },
              ],
            });
          }
          if (parsed.pathname.endsWith('/PCGAFD/entitlements')) {
            return jsonHttpResponse({ entitlements: [] });
          }
        }

        if (
          parsed.hostname === 'collections.mp.microsoft.com' &&
          parsed.pathname === '/v6.0/collections/query'
        ) {
          let bodyObj: any = {};
          try {
            bodyObj = JSON.parse(String(init?.body || '{}'));
          } catch {}
          if (Array.isArray(bodyObj.productTypes) && bodyObj.productTypes[0] === 'Pass') {
            return jsonHttpResponse({
              items: [
                {
                  productId: 'CFQ7TTC0KGQ8',
                  skuId: '0001',
                  status: 'Active',
                  endDate: '2028-01-01T00:00:00.000Z',
                },
              ],
            });
          }
          return jsonHttpResponse({ items: [] });
        }

        if (parsed.hostname === 'catalog.gamepass.com' && parsed.pathname === '/sigls/v3') {
          const siglId = parsed.searchParams.get('id');
          if (siglId === GAMEPASS_SIGL_IDS.PC_GAME_PASS_ALL) {
            return jsonHttpResponse([
              { siglId: 'synth-sigl', title: 'PC Game Pass' },
              { id: ROLLING_BIG_ID },
            ]);
          }
          return jsonHttpResponse([{ siglId: 'synth-aux', title: 'Aux' }]);
        }

        if (parsed.hostname === 'catalog.gamepass.com' && parsed.pathname === '/sigls/v2') {
          return jsonHttpResponse([{ siglId: 'synth-v2', title: 'Legacy Aux' }]);
        }

        if (parsed.hostname === 'displaycatalog.mp.microsoft.com') {
          displayCatalogFetchCount += 1;
          return jsonHttpResponse({
            Products: [
              makeSyntheticDisplayCatalogProduct({
                productId: ROLLING_BIG_ID,
                title: 'Synthetic Horizon Vanguard',
                satisfyingEntitlementKeys: ['big:CFQ7TTC0KGQ8:0001'],
                availabilityStartIso: '2025-06-01T00:00:00.000Z',
                availabilityEndIso: currentDisplayCatalogEndIso,
              }),
            ],
          });
        }

        throw new Error(`Unhandled URL in syncXboxCatalog test: ${rawUrl}`);
      });

      // Sync 1 at T0 (2026-05-01): populates SQLite cache with EndDate = 2026-06-01
      const sync1 = await syncXboxCatalog({
        storeToken: 'XBL3.0 x=9000000000000001;synthetic_store_token',
        collectionsToken: 't=synthetic_msa_collections_ticket',
        syncMode: 'full_pc_game_pass',
        market: 'US',
        locale: 'en-US',
        userDataDir: cacheUserDataDir,
        fetchImpl,
        nowMs: t0Ms,
      });
      expect(displayCatalogFetchCount).toBe(1);
      expect(sync1.games.map((g: any) => g.xboxProductId || g.platforms?.[0]?.xboxProductId)).toContain(
        ROLLING_BIG_ID
      );
      expect(
        fs.existsSync(path.join(cacheUserDataDir, 'xbox_catalog_cache_v1.sqlite'))
      ).toBe(true);

      // Upstream Microsoft Store renews DisplayCatalog EndDate to 2027-06-01; local clock advances to 2026-06-15
      currentDisplayCatalogEndIso = '2027-06-01T00:00:00.000Z';

      const sync2 = await syncXboxCatalog({
        storeToken: 'XBL3.0 x=9000000000000001;synthetic_store_token',
        collectionsToken: 't=synthetic_msa_collections_ticket',
        syncMode: 'full_pc_game_pass',
        market: 'US',
        locale: 'en-US',
        userDataDir: cacheUserDataDir,
        fetchImpl,
        nowMs: rolledOverMs,
      });

      // Must have evicted/bypassed the rolled-over SQLite entry and re-fetched live DisplayCatalog!
      expect(displayCatalogFetchCount).toBe(2);
      const syncedRollingGame = sync2.games.find(
        (g: any) =>
          (g.xboxProductId || g.platforms?.[0]?.xboxProductId) === ROLLING_BIG_ID
      );
      expect(syncedRollingGame).toBeDefined();
      expect(syncedRollingGame.title).toBe('Synthetic Horizon Vanguard');
      expect(syncedRollingGame.platforms[0]).toMatchObject({
        platformId: 'xbox',
        xboxProductId: ROLLING_BIG_ID,
        ownershipType: 'subscription',
      });
      expect(Boolean(syncedRollingGame.platforms[0].subscriptionExpired)).toBe(false);
    });

    it('3.4 passes Zero-PII & clean-room hygiene scan on this test file itself (0 violations)', () => {
      const content = fs.readFileSync(THIS_TEST_FILE_PATH, 'utf8');
      const violations = scanContentForPiiViolations(
        content,
        'tests/runnerBackgroundUpdaterAndXboxGhostHeal.test.tsx'
      );
      expect(violations).toEqual([]);
    });
  });

  // ==========================================================================
  // SUITE 4 — Wave 1A/1B: 1-Click Runner "Update" UX, Verified Upstream Sources,
  //           Heroic -> /Applications Non-Destructive Upgrade & Wizard Isolation
  // ==========================================================================
  describe('Suite 4 — 1-Click Runner "Update" UX, Verified Upstream Sources, Heroic -> /Applications Upgrade & Setup Wizard Isolation (darwin + win32 safe)', () => {
    it('4.1 enforces single 1-click "Update" button UX across crossover/gptk/wine/crossover_preview, always-visible crossover_preview with Sign In & Install, masks user home paths via formatUserFacingPath, and promotes stableSurpassesPreview to crossover on 1-click Update', async () => {
      expect(
        formatUserFacingPath(
          '/Users/player1/Library/Application Support/heroic/tools/wine/Wine-Staging-macOS-11.18/bin/wine64'
        )
      ).toBe('~/Library/Application Support/heroic/tools/wine/Wine-Staging-macOS-11.18/bin/wine64');
      expect(
        formatUserFacingPath('/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine')
      ).toBe('/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine');

      const synthGame = makeCanonicalGameFixture({
        id: 'steam-994001',
        steamAppId: 994001,
        title: 'Synthetic Orbital Bastion',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '994001',
            installed: true,
            installPath: '/Users/test/Games/SyntheticOrbitalBastion',
            executablePath: '/Users/test/Games/SyntheticOrbitalBastion/Bastion.exe',
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      const crossoverLayer: CompatibilityLayerInfo = {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
        appPath: '/Applications/CrossOver.app',
        version: '26.3.0',
        availableBottles: ['OneLauncher'],
      };
      const heroicGptkLayer: CompatibilityLayerInfo = {
        id: 'gptk',
        type: 'gptk',
        name: 'Game Porting Toolkit (Game-Porting-Toolkit-3.0b3)',
        binaryPath:
          '/Users/player1/Library/Application Support/heroic/tools/game-porting-toolkit/Game-Porting-Toolkit-3.0b3/bin/wine64',
        version: '3.0b3',
        availableBottles: [],
      };
      const heroicWineLayer: CompatibilityLayerInfo = {
        id: 'wine',
        type: 'wine',
        name: 'Open-Source Wine (Heroic)',
        binaryPath:
          '/Users/player1/Library/Application Support/heroic/tools/wine/Wine-Staging-macOS-11.18/bin/wine64',
        version: '11.18',
        availableBottles: [],
      };
      const previewLayer: CompatibilityLayerInfo = {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        binaryPath:
          '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
        appPath: '/Applications/CrossOver Preview.app',
        version: '27.0.0',
        availableBottles: ['OneLauncher'],
      };

      const updatesMap: Record<string, CompatibilityLayerUpdateInfo> = {
        crossover: {
          runnerType: 'crossover',
          installed: true,
          installedVersion: '26.3.0',
          latestVersion: '26.4.0',
          updateAvailable: true,
          canAutoUpdate: true,
          updateMethod: 'direct_download',
          checkedAt: '2026-06-15T12:00:00.000Z',
        },
        gptk: {
          runnerType: 'gptk',
          installed: true,
          installedVersion: '3.0b3',
          latestVersion: '3.0-3',
          updateAvailable: true,
          canAutoUpdate: true,
          updateMethod: 'direct_download',
          checkedAt: '2026-06-15T12:00:00.000Z',
        },
        wine: {
          runnerType: 'wine',
          installed: true,
          installedVersion: '11.18',
          latestVersion: '11.21',
          updateAvailable: true,
          canAutoUpdate: true,
          updateMethod: 'direct_download',
          checkedAt: '2026-06-15T12:00:00.000Z',
        },
        crossover_preview: {
          runnerType: 'crossover_preview',
          installed: true,
          installedVersion: '27.0.0',
          latestVersion: '27.0.1',
          updateAvailable: true,
          canAutoUpdate: true,
          updateMethod: 'direct_download',
          checkedAt: '2026-06-15T12:00:00.000Z',
        },
      };

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        id: 'steam-994001',
        platformId: 'steam',
        platformGameId: '994001',
        title: 'Synthetic Orbital Bastion',
        installPath: '/Users/test/Games/SyntheticOrbitalBastion',
        executablePath: '/Users/test/Games/SyntheticOrbitalBastion/Bastion.exe',
        executableArchitecture: 'x64',
        isWindowsBinaryOnMac: true,
      } as InstalledGameRecord);

      // Part A: All 4 macOS compatibility runners (`crossover`, `crossover_preview`, `gptk`, `wine`)
      // are always visible even when `crossover_preview` is uninstalled, and selecting uninstalled
      // `crossover_preview` renders `install-runner-brew-btn` with 'Sign In & Install CrossOver Preview (~480 MB)'
      const layersWithoutPreview = [crossoverLayer, heroicGptkLayer, heroicWineLayer];
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(layersWithoutPreview);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(layersWithoutPreview);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue(updatesMap);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue(updatesMap);

      const modalNoPreview = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let treeNoPreview = modalNoPreview.render();
      await Promise.resolve();
      treeNoPreview = modalNoPreview.render();

      const runnerSelectNoPreview = findVNodeByTestId(treeNoPreview, 'compat-runner-select');
      const optionValuesNoPreview = findVNodes(
        runnerSelectNoPreview,
        (n) => n.type === 'option'
      ).map((o) => o.props.value);
      expect(optionValuesNoPreview).toEqual(['crossover', 'crossover_preview', 'gptk', 'wine']);

      runnerSelectNoPreview.props.onChange({ target: { value: 'crossover_preview' } });
      treeNoPreview = modalNoPreview.render();
      const previewInstallBtn = findVNodeByTestId(treeNoPreview, 'install-runner-brew-btn');
      expect(previewInstallBtn).toBeDefined();
      expect(extractVNodeText(previewInstallBtn).trim()).toBe(
        'Sign In & Install CrossOver Preview (~480 MB)'
      );
      expect(findVNodeByTestId(treeNoPreview, 'download-runner-btn')).toBeUndefined();
      expect(findVNodeByTestId(treeNoPreview, 'install-runner-archive-btn')).toBeUndefined();
      expect(auditWcag22AA(treeNoPreview)).toEqual([]);
      modalNoPreview.unmount();

      // Part B: Verify 1-button "Update" UX + masked Heroic paths across all 4 runners
      const allFourLayers = [crossoverLayer, previewLayer, heroicGptkLayer, heroicWineLayer];
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(allFourLayers);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(allFourLayers);

      const modalAll = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let treeAll = modalAll.render();
      await Promise.resolve();
      treeAll = modalAll.render();

      const optionValuesWithPreview = findVNodes(
        findVNodeByTestId(treeAll, 'compat-runner-select'),
        (n) => n.type === 'option'
      ).map((o) => o.props.value);
      expect(optionValuesWithPreview).toEqual([
        'crossover',
        'crossover_preview',
        'gptk',
        'wine',
      ]);

      const expectedButtons: Array<{
        runner: 'crossover' | 'gptk' | 'wine' | 'crossover_preview';
        expectedAriaLabel: string;
        expectedRenderedBinaryPath: string;
      }> = [
        {
          runner: 'crossover',
          expectedAriaLabel: 'Update CrossOver to v26.4.0',
          expectedRenderedBinaryPath:
            '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
        },
        {
          runner: 'gptk',
          expectedAriaLabel: 'Update Apple GPTK to v3.0-3',
          expectedRenderedBinaryPath:
            '~/Library/Application Support/heroic/tools/game-porting-toolkit/Game-Porting-Toolkit-3.0b3/bin/wine64',
        },
        {
          runner: 'wine',
          expectedAriaLabel: 'Update Open-Source Wine to v11.21',
          expectedRenderedBinaryPath:
            '~/Library/Application Support/heroic/tools/wine/Wine-Staging-macOS-11.18/bin/wine64',
        },
        {
          runner: 'crossover_preview',
          expectedAriaLabel: 'Update CrossOver Preview to v27.0.1',
          expectedRenderedBinaryPath:
            '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
        },
      ];

      for (const item of expectedButtons) {
        findVNodeByTestId(treeAll, 'compat-runner-select').props.onChange({
          target: { value: item.runner },
        });
        treeAll = modalAll.render();

        const updateBtn = findVNodeByTestId(treeAll, 'update-runner-btn');
        expect(updateBtn).toBeDefined();
        expect(extractVNodeText(updateBtn).trim()).toBe('Update');
        expect(updateBtn.props['aria-label']).toBe(item.expectedAriaLabel);

        // Zero secondary/clutter runner buttons may appear
        expect(findVNodeByTestId(treeAll, 'download-runner-btn')).toBeUndefined();
        expect(findVNodeByTestId(treeAll, 'install-runner-archive-btn')).toBeUndefined();
        expect(findVNodeByTestId(treeAll, 'switch-to-stable-crossover-btn')).toBeUndefined();

        const compatSection = findVNodes(
          treeAll,
          (n) => n.props?.['data-section'] === 'compatibility-layer-settings'
        )[0];
        const sectionText = extractVNodeText(compatSection);
        expect(sectionText).toContain(item.expectedRenderedBinaryPath);
        expect(sectionText).not.toContain('/Users/player1/');
        expect(auditWcag22AA(treeAll)).toEqual([]);
      }
      modalAll.unmount();

      // Part C: When crossover_preview has stableSurpassesPreview: true, clicking the single "Update"
      // button updates via switchToStableCrossOver and promotes compatibilityLayer to 'crossover'
      const surpassedPreviewLayer: CompatibilityLayerInfo = {
        ...previewLayer,
        version: '26.2.0',
      };
      const updatedStableLayer: CompatibilityLayerInfo = {
        ...crossoverLayer,
        version: '26.4.0',
      };
      const surpassedUpdates: Record<string, CompatibilityLayerUpdateInfo> = {
        crossover_preview: {
          runnerType: 'crossover_preview',
          installed: true,
          installedVersion: '26.2.0',
          latestVersion: '26.4.0',
          updateAvailable: true,
          canAutoUpdate: false,
          stableSurpassesPreview: true,
          updateMethod: 'vendor_portal',
          checkedAt: '2026-06-15T12:00:00.000Z',
        },
      };

      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([surpassedPreviewLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        surpassedPreviewLayer,
      ]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue(surpassedUpdates);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue(
        surpassedUpdates
      );
      const updateSpy = vi
        .spyOn(launcherService, 'updateCompatibilityLayer')
        .mockResolvedValue({
          success: true,
          updated: true,
          runnerType: 'crossover',
          detectedLayers: [updatedStableLayer, surpassedPreviewLayer],
          message: 'Updated to CrossOver 26.4.0.',
        } as any);

      const modalPromote = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game: synthGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });
      let treePromote = modalPromote.render();
      await Promise.resolve();
      treePromote = modalPromote.render();

      findVNodeByTestId(treePromote, 'compat-runner-select').props.onChange({
        target: { value: 'crossover_preview' },
      });
      treePromote = modalPromote.render();

      expect(findVNodeByTestId(treePromote, 'switch-to-stable-crossover-btn')).toBeUndefined();
      const singlePromoteUpdateBtn = findVNodeByTestId(treePromote, 'update-runner-btn');
      expect(singlePromoteUpdateBtn).toBeDefined();
      expect(extractVNodeText(singlePromoteUpdateBtn).trim()).toBe('Update');

      await singlePromoteUpdateBtn.props.onClick();
      treePromote = modalPromote.render();

      expect(updateSpy).toHaveBeenCalledWith('crossover_preview', {
        switchToStableCrossOver: true,
      });
      expect(findVNodeByTestId(treePromote, 'compat-runner-select').props.value).toBe('crossover');
      modalPromote.unmount();
    });

    it('4.2 resolves Wine-Staging hyphenated folder channel across both Homebrew cask and Gcenx/macOS_Wine_builds releases, and enables 1-click Sparkle direct_download for CrossOver Preview.app with SUFeedURL', async () => {
      const dir = makeTempDir('upstream-sources');
      const appsDir = path.join(dir, 'Applications');
      fs.mkdirSync(appsDir, { recursive: true });

      // Seed CrossOver Preview.app with valid CodeWeavers SUFeedURL + SUPublicEDKey in Info.plist
      const previewAppPath = path.join(appsDir, 'CrossOver Preview.app');
      const previewBinDir = path.join(previewAppPath, 'Contents/SharedSupport/CrossOver/bin');
      fs.mkdirSync(previewBinDir, { recursive: true });
      fs.writeFileSync(path.join(previewBinDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const previewFeedUrl = 'https://www.codeweavers.com/xml/versions/cxmac-preview.xml';
      fs.writeFileSync(
        path.join(previewAppPath, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.codeweavers.CrossOverPreview</string>
  <key>CFBundleShortVersionString</key>
  <string>27.0.0</string>
  <key>CFBundleVersion</key>
  <string>27.0.0.41001</string>
  <key>SUFeedURL</key>
  <string>${previewFeedUrl}</string>
  <key>SUPublicEDKey</key>
  <string>SYNTHETIC_PREVIEW_ED25519_PUBLIC_KEY_B64==</string>
</dict>
</plist>`,
        'utf8'
      );

      const queriedUrls: string[] = [];
      const httpGetText = vi.fn(async (url: string) => {
        queriedUrls.push(url);
        if (url === 'https://formulae.brew.sh/api/cask/wine@staging.json') {
          return JSON.stringify({
            token: 'wine@staging',
            version: '11.16',
            disabled: true,
            url: 'https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.16/wine-staging-11.16-osx64.tar.xz',
          });
        }
        if (url === 'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases?per_page=20') {
          return JSON.stringify([
            {
              tag_name: '11.22-devel',
              draft: false,
              prerelease: true,
              assets: [
                {
                  name: 'wine-devel-11.22-osx64.tar.xz',
                  browser_download_url:
                    'https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.22-devel/wine-devel-11.22-osx64.tar.xz',
                },
              ],
            },
            {
              tag_name: '11.21',
              draft: false,
              prerelease: false,
              assets: [
                {
                  name: 'wine-staging-11.21-osx64.tar.xz',
                  browser_download_url:
                    'https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.21/wine-staging-11.21-osx64.tar.xz',
                },
              ],
            },
          ]);
        }
        if (url === previewFeedUrl) {
          return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <item>
      <title>CrossOver Preview 27.0.1</title>
      <enclosure url="https://media.codeweavers.com/pub/crossover/cxmac/preview/crossover-preview-27.0.1.zip"
                 sparkle:version="27.0.1.41050"
                 sparkle:shortVersionString="27.0.1"
                 sparkle:edSignature="SYNTHETIC_SIG=="
                 length="412000000"
                 type="application/octet-stream" />
    </item>
  </channel>
</rss>`;
        }
        if (url === 'https://www.codeweavers.com/xml/versions/cxmac.xml') {
          return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <item>
      <enclosure url="https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-26.4.0.zip"
                 sparkle:version="26.4.0.40210"
                 sparkle:shortVersionString="26.4.0" />
    </item>
  </channel>
</rss>`;
        }
        throw new Error(`Unexpected upstream feed URL in 4.2: ${url}`);
      });

      const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
        platform: 'darwin',
        arch: 'arm64',
        darwinKernelMajor: 25,
        httpGetText,
        layers: [
          {
            id: 'wine',
            type: 'wine',
            name: 'Open-Source Wine (Heroic)',
            binaryPath:
              '/Users/player1/Library/Application Support/heroic/tools/wine/Wine-Staging-macOS-latest/bin/wine64',
            version: '11.18',
          },
          {
            id: 'crossover_preview',
            type: 'crossover_preview',
            name: 'CrossOver Preview',
            appPath: previewAppPath,
            binaryPath: path.join(previewBinDir, 'wine'),
            version: '27.0.0',
            buildVersion: '27.0.0.41001',
          },
        ],
      });

      expect(queriedUrls).toContain('https://formulae.brew.sh/api/cask/wine@staging.json');
      expect(queriedUrls).toContain(
        'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases?per_page=20'
      );
      expect(queriedUrls).toContain(previewFeedUrl);

      expect(updates.wine).toMatchObject({
        runnerType: 'wine',
        installedVersion: '11.18',
        latestVersion: '11.21',
        updateAvailable: true,
        canAutoUpdate: true,
        updateMethod: 'direct_download',
      });

      expect(updates.crossover_preview).toMatchObject({
        runnerType: 'crossover_preview',
        installedVersion: '27.0.0',
        latestVersion: '27.0.1',
        updateAvailable: true,
        canAutoUpdate: true,
        updateMethod: 'direct_download',
      });
    });

    it('4.3 non-destructively auto-updates Heroic wine (11.18 -> 11.21) and Heroic gptk (3.0b3 -> 3.0-3) into /Applications via runEnvironmentSetupTasks, records receipts, selects highest version, and preserves preferredRunnerType', async () => {
      const dir = makeTempDir('heroic-upgrade-e2e');
      const homedir = path.join(dir, 'Users', 'player1');
      const userDataDir = path.join(dir, 'userData');
      const targetAppsDir = path.join(dir, 'Applications');
      fs.mkdirSync(targetAppsDir, { recursive: true });
      fs.mkdirSync(userDataDir, { recursive: true });

      // 1. Seed synthetic Heroic Wine Staging (11.18) & Heroic GPTK (3.0b3)
      const heroicWineDir = path.join(
        homedir,
        'Library/Application Support/heroic/tools/wine/Wine-Staging-macOS-11.18'
      );
      const heroicWineBin = path.join(heroicWineDir, 'bin/wine64');
      fs.mkdirSync(path.dirname(heroicWineBin), { recursive: true });
      fs.writeFileSync(heroicWineBin, '#!/bin/sh\n# HEROIC-WINE-11.18\nexit 0\n', { mode: 0o755 });

      const heroicGptkDir = path.join(
        homedir,
        'Library/Application Support/heroic/tools/game-porting-toolkit/Game-Porting-Toolkit-3.0b3'
      );
      const heroicGptkBin = path.join(heroicGptkDir, 'bin/wine64');
      fs.mkdirSync(path.dirname(heroicGptkBin), { recursive: true });
      fs.writeFileSync(heroicGptkBin, '#!/bin/sh\n# HEROIC-GPTK-3.0b3\nexit 0\n', { mode: 0o755 });

      // Persist CrossOver as user's preferred runner before updating secondary runners
      environmentHealthProber.saveSetupWizardState(
        {
          preferredRunnerType: 'crossover',
          configuredComponents: ['runner_crossover'],
        },
        { homedir, userDataDir }
      );

      const wineArchiveBytes = Buffer.from('SYNTHETIC-WINE-STAGING-11.21-TAR-XZ-PAYLOAD');
      const wineSha256 = crypto.createHash('sha256').update(wineArchiveBytes).digest('hex');
      const wineAssetUrl =
        'https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.21/wine-staging-11.21-osx64.tar.xz';

      const gptkArchiveBytes = Buffer.from('SYNTHETIC-GPTK-3.0-3-TAR-XZ-PAYLOAD');
      const gptkSha256 = crypto.createHash('sha256').update(gptkArchiveBytes).digest('hex');
      const gptkAssetUrl =
        'https://github.com/Gcenx/game-porting-toolkit/releases/download/v3.0-3/game-porting-toolkit-3.0-3.tar.xz';

      const upstreamJsonMap: Record<string, string> = {
        'https://formulae.brew.sh/api/cask/wine@staging.json': JSON.stringify({
          token: 'wine@staging',
          version: '11.16',
          disabled: true,
        }),
        'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases?per_page=20': JSON.stringify([
          {
            tag_name: '11.21',
            draft: false,
            assets: [
              {
                name: 'wine-staging-11.21-osx64.tar.xz',
                browser_download_url: wineAssetUrl,
                digest: `sha256:${wineSha256}`,
              },
            ],
          },
        ]),
        'https://api.github.com/repos/Gcenx/game-porting-toolkit/releases/latest': JSON.stringify({
          tag_name: 'v3.0-3',
          assets: [
            {
              name: 'game-porting-toolkit-3.0-3.tar.xz',
              browser_download_url: gptkAssetUrl,
              digest: `sha256:${gptkSha256}`,
            },
          ],
        }),
        'https://raw.githubusercontent.com/Gcenx/homebrew-wine/master/Casks/game-porting-toolkit.rb': `cask "game-porting-toolkit"\n  version "3.0-3"\n  sha256 "${gptkSha256}"\nend\n`,
      };

      const httpGetText = vi.fn(async (url: string) => {
        if (upstreamJsonMap[url] !== undefined) return upstreamJsonMap[url];
        throw new Error(`Unexpected httpGetText URL in 4.3: ${url}`);
      });

      const fetchFn = vi.fn(async (url: string) => {
        if (upstreamJsonMap[url] !== undefined) {
          const txt = upstreamJsonMap[url];
          return {
            ok: true,
            status: 200,
            text: async () => txt,
            json: async () => JSON.parse(txt),
          };
        }
        if (url === wineAssetUrl || url === gptkAssetUrl) {
          const payload = url === wineAssetUrl ? wineArchiveBytes : gptkArchiveBytes;
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h: string) =>
                h.toLowerCase() === 'content-length' ? String(payload.length) : null,
            },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(payload));
                controller.close();
              },
            }),
          };
        }
        throw new Error(`Unexpected fetchFn URL in 4.3: ${url}`);
      });

      const sharedEnvOpts = {
        platform: 'darwin',
        arch: 'arm64',
        darwinKernelMajor: 25,
        homedir,
        userDataDir,
        customApplicationsDir: targetAppsDir,
        applicationsDirs: [targetAppsDir],
        rosettaInstalled: true,
        freeDiskBytes: 25 * 1024 * 1024 * 1024,
        skipProcessCheck: true,
        skipStagingCodesignVerify: true,
        httpGetText,
        fetchFn,
        fetchImpl: fetchFn,
        verifySignatureFn: async () => ({ valid: true }),
        onExecDitto: async (src: string, dest: string) => {
          await fs.promises.cp(src, dest, { recursive: true, force: true });
        },
        execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, '', ''),
        onExtractArchive: async (archivePath: string, stagingDir: string) => {
          if (path.basename(archivePath).startsWith('Wine')) {
            const appDir = path.join(stagingDir, 'Wine Staging.app');
            const binDir = path.join(appDir, 'Contents/Resources/wine/bin');
            fs.mkdirSync(binDir, { recursive: true });
            fs.writeFileSync(path.join(binDir, 'wine64'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            fs.writeFileSync(
              path.join(appDir, 'Contents/Info.plist'),
              `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>11.21</string>
  <key>CFBundleVersion</key><string>11.21</string>
</dict></plist>`,
              'utf8'
            );
          } else {
            const appDir = path.join(stagingDir, 'Game Porting Toolkit.app');
            const binDir = path.join(appDir, 'Contents/Resources/wine/bin');
            fs.mkdirSync(binDir, { recursive: true });
            fs.writeFileSync(path.join(binDir, 'wine64'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            // Upstream GPTK Info.plist reports short version "3.0" while release tag is "3.0-3"
            fs.writeFileSync(
              path.join(appDir, 'Contents/Info.plist'),
              `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>3.0</string>
  <key>CFBundleVersion</key><string>3.0</string>
</dict></plist>`,
              'utf8'
            );
          }
        },
      };

      // Pre-run health check detects Heroic runners with update_available
      const beforeHealth = await environmentHealthProber.probeEnvironmentHealth({
        ...sharedEnvOpts,
        connectedStorefronts: [],
      });
      expect(beforeHealth.components.runner_wine.status).toBe('update_available');
      expect(beforeHealth.components.runner_gptk.status).toBe('update_available');

      // Execute Setup Wizard runner update tasks (forceUpdate: true)
      const setupRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          runId: 'run-heroic-upgrade-4-3',
          tasks: [
            {
              componentId: 'runner_wine',
              action: 'install_runner',
              runnerType: 'wine',
              forceUpdate: true,
            },
            {
              componentId: 'runner_gptk',
              action: 'install_runner',
              runnerType: 'gptk',
              forceUpdate: true,
            },
          ],
        },
        sharedEnvOpts
      );

      expect(setupRes.success).toBe(true);
      expect(setupRes.outcomes).toEqual([
        expect.objectContaining({
          componentId: 'runner_wine',
          action: 'install_runner',
          status: 'completed',
        }),
        expect.objectContaining({
          componentId: 'runner_gptk',
          action: 'install_runner',
          status: 'completed',
        }),
      ]);
      expect(JSON.stringify(setupRes)).not.toContain('managed by Heroic Games Launcher');

      // Synthetic Heroic directories & binaries remain 100% untouched
      expect(fs.existsSync(heroicWineBin)).toBe(true);
      expect(fs.readFileSync(heroicWineBin, 'utf8')).toContain('HEROIC-WINE-11.18');
      expect(fs.existsSync(heroicGptkBin)).toBe(true);
      expect(fs.readFileSync(heroicGptkBin, 'utf8')).toContain('HEROIC-GPTK-3.0b3');

      // Standalone .app bundles installed into target Applications directory + receipt persisted
      const installedWineApp = path.join(targetAppsDir, 'Wine Staging.app');
      const installedGptkApp = path.join(targetAppsDir, 'Game Porting Toolkit.app');
      expect(fs.existsSync(installedWineApp)).toBe(true);
      expect(fs.existsSync(installedGptkApp)).toBe(true);

      const receiptsPath = path.join(
        homedir,
        'Library/Application Support/OneLauncher/runner-install-receipts.json'
      );
      expect(fs.existsSync(receiptsPath)).toBe(true);
      const receiptsJson = JSON.parse(fs.readFileSync(receiptsPath, 'utf8'));
      const gptkReceipt = Object.values(receiptsJson.receipts || {}).find(
        (r: any) => r?.runnerType === 'gptk'
      ) as any;
      expect(gptkReceipt).toBeDefined();
      expect(gptkReceipt.releaseVersion).toBe('3.0-3');

      // Subsequent detectCompatibilityLayers selects the newer /Applications bundles over Heroic
      const afterLayers = macNativeInstaller.detectCompatibilityLayers(sharedEnvOpts);
      const detectedWine = afterLayers.find((l: any) => l.type === 'wine');
      const detectedGptk = afterLayers.find((l: any) => l.type === 'gptk');
      expect(detectedWine).toMatchObject({
        appPath: installedWineApp,
        version: '11.21',
      });
      expect(detectedGptk).toMatchObject({
        appPath: installedGptkApp,
        version: '3.0.3',
        displayVersion: '3.0-3',
      });

      // Post-run probeEnvironmentHealth reports both runners as ready (no longer update_available)
      const afterHealth = await environmentHealthProber.probeEnvironmentHealth({
        ...sharedEnvOpts,
        connectedStorefronts: [],
        forceRefreshRunnerUpdates: true,
      });
      expect(afterHealth.components.runner_wine.status).toBe('ready');
      expect(afterHealth.components.runner_gptk.status).toBe('ready');

      // Preferred runner remains 'crossover' (not clobbered by forceUpdate on secondary runners)
      const persistedState = environmentHealthProber.getSetupWizardState({ homedir, userDataDir });
      expect(persistedState.preferredRunnerType).toBe('crossover');
    });

    it('4.4 isolates sync_first_party_manifests from failed runner updates in ProvisioningProgressPanel and EnvironmentSetupService', async () => {
      const baseSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_wine: {
          title: 'Open-Source Wine',
          shortLabel: 'Open-Source Wine',
          status: 'update_available',
          version: '11.18',
          latestVersion: '11.21',
          canAutoInstall: true,
        },
        runner_gptk: {
          title: 'Apple Game Porting Toolkit',
          shortLabel: 'Apple GPTK',
          status: 'update_available',
          version: '3.0b3',
          latestVersion: '3.0-3',
          canAutoInstall: true,
        },
      });

      // 1. ProvisioningProgressPanel: renders "Update ..." for forceUpdate tasks and
      //    "Sync installed game folders" ("Synced") instead of a duplicate "Apple Game Porting Toolkit" ("Installed") row
      const panel = createDomain12DeepRenderer(ProvisioningProgressPanel, {
        plannedTasks: [
          {
            componentId: 'runner_wine',
            action: 'install_runner',
            runnerType: 'wine',
            forceUpdate: true,
          },
          {
            componentId: 'runner_gptk',
            action: 'install_runner',
            runnerType: 'gptk',
            forceUpdate: true,
          },
        ],
        components: baseSnapshot.components,
        isRunning: false,
        latestProgress: null,
        outcomes: [
          {
            componentId: 'runner_gptk',
            action: 'install_runner',
            status: 'failed',
            message: 'Apple Game Porting Toolkit update failed.',
            error: 'Simulated SHA-256 verification error',
          },
          {
            componentId: 'runner_gptk',
            action: 'sync_first_party_manifests',
            status: 'completed',
            message: 'Synced local storefront game folders.',
          },
        ],
        lastRunError: null,
        onCancelProvisioning: vi.fn(),
      });

      const panelTree = panel.render();
      expect(
        extractVNodeText(findVNodeByTestId(panelTree, 'planned-task-runner_wine-install_runner'))
      ).toContain('Update Open-Source Wine');
      expect(
        extractVNodeText(findVNodeByTestId(panelTree, 'planned-task-runner_gptk-install_runner'))
      ).toContain('Update Apple Game Porting Toolkit');

      const failedGptkRow = findVNodeByTestId(
        panelTree,
        'setup-outcome-runner_gptk-install_runner'
      );
      expect(failedGptkRow).toBeDefined();
      expect(extractVNodeText(failedGptkRow)).toContain('Apple Game Porting Toolkit');
      expect(extractVNodeText(failedGptkRow)).toContain('Failed');

      const syncManifestRow = findVNodeByTestId(
        panelTree,
        'setup-outcome-runner_gptk-sync_first_party_manifests'
      );
      expect(syncManifestRow).toBeDefined();
      expect(extractVNodeText(syncManifestRow)).toContain('Sync installed game folders');
      expect(extractVNodeText(syncManifestRow)).toContain('Synced');
      expect(extractVNodeText(syncManifestRow)).not.toContain('Apple Game Porting Toolkit');
      expect(extractVNodeText(syncManifestRow)).not.toContain('Installed');
      expect(auditWcag22AA(panelTree)).toEqual([]);
      panel.unmount();

      // 2. EnvironmentSetupService: sync_first_party_manifests completion (sharing componentId: 'runner_gptk')
      //    MUST NOT mark runner_gptk as 'ready' when install_runner failed
      let progressHandler: ((evt: any) => void) | null = null;
      const stalePreRunSnapshot = structuredClone(baseSnapshot);

      (globalThis as any).window.electronAPI = {
        ...((globalThis as any).window.electronAPI || {}),
        probeEnvironmentHealth: vi.fn(async () => structuredClone(stalePreRunSnapshot)),
        onEnvironmentSetupProgress: vi.fn((cb: (evt: any) => void) => {
          progressHandler = cb;
          return () => {
            progressHandler = null;
          };
        }),
        runEnvironmentSetupTasks: vi.fn(async (req: any) => {
          // Emit live progress completion for sync_first_party_manifests with componentId 'runner_gptk'
          progressHandler?.({
            runId: req.runId || 'run-sync-isolation',
            stepIndex: 1,
            totalSteps: 2,
            componentId: 'runner_gptk',
            action: 'sync_first_party_manifests',
            phase: 'completed',
            progressPercent: 100,
            message: 'Synced local storefront game folders.',
          });
          // Assert live progress listener did NOT flip runner_gptk to 'ready'
          expect(isolatedService.getLastSnapshot()?.components.runner_gptk.status).toBe(
            'update_available'
          );

          return {
            success: false,
            runId: req.runId || 'run-sync-isolation',
            outcomes: [
              {
                componentId: 'runner_gptk',
                action: 'install_runner',
                status: 'failed',
                message: 'Apple Game Porting Toolkit update failed.',
                error: 'Simulated SHA-256 verification error',
              },
              {
                componentId: 'runner_gptk',
                action: 'sync_first_party_manifests',
                status: 'completed',
                message: 'Synced local storefront game folders.',
              },
            ],
            snapshot: structuredClone(stalePreRunSnapshot),
            error: '1 setup task failed.',
          };
        }),
      };

      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([]);
      vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue([] as any);

      const isolatedService = new EnvironmentSetupService();
      await isolatedService.probeHealth([], { forceFresh: true });
      expect(isolatedService.getLastSnapshot()?.components.runner_gptk.status).toBe(
        'update_available'
      );

      const runResult = await isolatedService.runSetupTasks({
        tasks: [
          {
            componentId: 'runner_gptk',
            action: 'install_runner',
            runnerType: 'gptk',
            forceUpdate: true,
          },
          {
            componentId: 'runner_gptk',
            action: 'sync_first_party_manifests',
          },
        ],
      });

      expect(runResult.success).toBe(false);
      expect(runResult.snapshot.components.runner_gptk.status).toBe('update_available');
      expect(isolatedService.getLastSnapshot()?.components.runner_gptk.status).toBe(
        'update_available'
      );
    });

    it('4.5 ad-hoc signs unsigned upstream Gcenx Wine Staging.app bundles after SHA-256 verification while failing closed on tampered signatures', async () => {
      const dir = makeTempDir('ol-wine-unsigned-45-');
      const homedir = path.join(dir, 'home');
      const targetAppsDir = path.join(dir, 'Applications');
      fs.mkdirSync(homedir, { recursive: true });
      fs.mkdirSync(targetAppsDir, { recursive: true });

      const wineArchiveBytes = Buffer.from('SYNTHETIC_UNSIGNED_GCENX_WINE_STAGING_11_21');
      const wineSha256 = crypto.createHash('sha256').update(wineArchiveBytes).digest('hex');
      const wineAssetUrl =
        'https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.21/wine-staging-11.21-osx64.tar.xz';
      const releasesJson = JSON.stringify([
        {
          tag_name: '11.21',
          assets: [
            {
              name: 'wine-staging-11.21-osx64.tar.xz',
              browser_download_url: wineAssetUrl,
              digest: `sha256:${wineSha256}`,
            },
          ],
        },
      ]);

      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('api.github.com/repos/Gcenx/macOS_Wine_builds/releases')) {
          return {
            ok: true,
            status: 200,
            text: async () => releasesJson,
            json: async () => JSON.parse(releasesJson),
          };
        }
        if (url === wineAssetUrl) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h: string) =>
                h.toLowerCase() === 'content-length' ? String(wineArchiveBytes.length) : null,
            },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(wineArchiveBytes));
                controller.close();
              },
            }),
          };
        }
        throw new Error(`Unexpected fetchFn URL in 4.5: ${url}`);
      });

      const codesignCalls: string[][] = [];
      let signedAppPaths = new Set<string>();

      const unsignedThenAdhocExecFn = (
        cmd: string,
        args: string[],
        _opts: any,
        cb: (err: any, stdout?: string, stderr?: string) => void
      ) => {
        if (cmd === '/usr/bin/codesign') {
          codesignCalls.push(args);
          const target = args[args.length - 1];
          if (args.includes('--force') && args.includes('-s')) {
            signedAppPaths.add(target);
            cb(null, '', '');
            return;
          }
          if (args.includes('--verify')) {
            const isSigned =
              signedAppPaths.has(target) ||
              Array.from(signedAppPaths).some((p) => path.basename(p) === path.basename(target));
            if (!isSigned) {
              const err: any = new Error('Command failed: /usr/bin/codesign --verify');
              err.stderr = `${target}: code object is not signed at all\nIn architecture: x86_64`;
              cb(err, '', err.stderr);
              return;
            }
            cb(null, '', '');
            return;
          }
          if (args.includes('-dv')) {
            cb(null, '', 'Signature=adhoc\nTeamIdentifier=not set\n');
            return;
          }
        }
        cb(null, '', '');
      };

      const existingHeroicWine = {
        id: 'wine',
        type: 'wine',
        name: 'Open-Source Wine (Heroic)',
        appPath: path.join(homedir, 'Library/Application Support/heroic/tools/wine/Wine-Staging-macOS-latest'),
        binaryPath: path.join(
          homedir,
          'Library/Application Support/heroic/tools/wine/Wine-Staging-macOS-latest/Contents/Resources/wine/bin/wine'
        ),
        version: '11.18',
      };

      const res = await environmentProvisioner.installRunnerDirect('wine', {
        platform: 'darwin',
        arch: 'arm64',
        homedir,
        customApplicationsDir: targetAppsDir,
        applicationsDirs: [targetAppsDir],
        existingLayer: existingHeroicWine,
        _runnerOperation: 'update',
        freeDiskBytes: 20 * 1024 * 1024 * 1024,
        skipProcessCheck: true,
        fetchFn,
        fetchImpl: fetchFn,
        execFileFn: unsignedThenAdhocExecFn,
        onExecDitto: async (src: string, dest: string) => {
          await fs.promises.cp(src, dest, { recursive: true, force: true });
          signedAppPaths.add(dest);
        },
        onExtractArchive: async (_archivePath: string, stagingDir: string) => {
          const appDir = path.join(stagingDir, 'Wine Staging.app');
          fs.mkdirSync(path.join(appDir, 'Contents/Resources/wine/bin'), { recursive: true });
          fs.writeFileSync(path.join(appDir, 'Contents/Resources/wine/bin/wine64'), '#!/bin/sh\n', {
            mode: 0o755,
          });
        },
      });

      expect(res.success).toBe(true);
      expect(res.installed).toBe(true);
      expect(
        codesignCalls.some(
          (args) => args.includes('--force') && args.includes('--deep') && args.includes('-')
        )
      ).toBe(true);

      // Tampered existing signature -> fails closed without ad-hoc re-signing over tampering
      const tamperedCalls: string[][] = [];
      await expect(
        environmentProvisioner.installRunnerDirect('wine', {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          customApplicationsDir: targetAppsDir,
          applicationsDirs: [targetAppsDir],
          existingLayer: existingHeroicWine,
          _runnerOperation: 'update',
          freeDiskBytes: 20 * 1024 * 1024 * 1024,
          skipProcessCheck: true,
          fetchFn,
          fetchImpl: fetchFn,
          execFileFn: (
            cmd: string,
            args: string[],
            _opts: any,
            cb: (err: any, stdout?: string, stderr?: string) => void
          ) => {
            if (cmd === '/usr/bin/codesign') {
              tamperedCalls.push(args);
              if (args.includes('--verify')) {
                const err: any = new Error('Command failed: /usr/bin/codesign --verify');
                err.stderr = 'a sealed resource is missing or invalid';
                cb(err, '', err.stderr);
                return;
              }
            }
            cb(null, '', '');
          },
          onExtractArchive: async (_archivePath: string, stagingDir: string) => {
            const appDir = path.join(stagingDir, 'Wine Staging.app');
            fs.mkdirSync(path.join(appDir, 'Contents/Resources/wine/bin'), { recursive: true });
          },
        })
      ).rejects.toThrow(/sealed resource is missing or invalid/i);
      expect(tamperedCalls.some((args) => args.includes('--force'))).toBe(false);
    });

    it('4.6 renders always-visible CrossOver Preview in Setup Wizard, auto-captures post-login Preview archive, enforces Developer ID 2C75U774H4 & INSTALLER_URL_BLOCKED guards, and handles window-close cancellation cleanly', async () => {
      // 1. Setup Wizard CompatibilityAndBottleStep: always-visible CrossOver Preview when missing
      const macMissingPreviewSnapshot = makeSyntheticSetupSnapshot('darwin', {
        runner_crossover: {
          status: 'ready',
          version: '26.3.0',
          canAutoInstall: true,
          requiresExternalDownload: false,
        },
        runner_crossover_preview: {
          status: 'missing',
          canAutoInstall: true,
          requiresExternalDownload: false,
        },
      });

      const stepMissingPreview = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: macMissingPreviewSnapshot,
        chosenRunner: 'crossover',
        onSelectRunner: vi.fn(),
        bottleMode: 'reuse_existing',
        onChangeBottleMode: vi.fn(),
        bottleName: 'OneLauncher',
        onChangeBottleName: vi.fn(),
        gptkDmgPath: '',
        onChangeGptkDmgPath: vi.fn(),
        selectedIds: new Set<EnvironmentComponentId>(['bottle_default']),
      });

      const stepTree = stepMissingPreview.render();
      const previewCard = findVNodeByTestId(stepTree, 'setup-runner-crossover-preview');
      expect(previewCard).toBeDefined();
      expect(extractVNodeText(previewCard)).toContain(
        'Not installed yet — sign in to CodeWeavers during setup to auto-download & install.'
      );
      expect(auditWcag22AA(stepTree)).toEqual([]);
      stepMissingPreview.unmount();

      // 2. probeEnvironmentHealth on darwin reports runner_crossover_preview canAutoInstall=true, requiresExternalDownload=false
      const dir = makeTempDir('cx-preview-signin-46');
      const homedir = path.join(dir, 'Users', 'player1');
      const userDataDir = path.join(dir, 'userData');
      const targetAppsDir = path.join(dir, 'Applications');
      fs.mkdirSync(homedir, { recursive: true });
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(targetAppsDir, { recursive: true });

      const probedDarwin = await environmentHealthProber.probeEnvironmentHealth({
        platform: 'darwin',
        arch: 'arm64',
        darwinKernelMajor: 25,
        homedir,
        userDataDir,
        customApplicationsDir: targetAppsDir,
        applicationsDirs: [targetAppsDir],
        rosettaInstalled: true,
        skipNetwork: true,
        execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, '', ''),
      });
      expect(probedDarwin.components.runner_crossover_preview.status).toBe('missing');
      expect(probedDarwin.components.runner_crossover_preview.canAutoInstall).toBe(true);
      expect(probedDarwin.components.runner_crossover_preview.requiresExternalDownload).toBe(false);

      // 3. End-to-End In-App Sign-In Auto-Capture via installCompatibilityLayer ({ runnerType: 'crossover_preview', mode: 'brew' })
      const recordedPhases: string[] = [];
      const verifySignatureSpy = vi.fn(async () => ({
        valid: true,
        teamIdentifier: '2C75U774H4',
      }));

      const seedPreviewBundle = (stagingDir: string) => {
        const appDir = path.join(stagingDir, 'CrossOver Preview.app');
        const binDir = path.join(appDir, 'Contents/SharedSupport/CrossOver/bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fs.writeFileSync(
          path.join(appDir, 'Contents/Info.plist'),
          `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.codeweavers.CrossOverPreview</string>
  <key>CFBundleShortVersionString</key><string>20261015</string>
  <key>CFBundleVersion</key><string>27.0.0</string>
</dict></plist>`,
          'utf8'
        );
        return appDir;
      };

      const installRes = await macNativeInstaller.installCompatibilityLayer(
        { runnerType: 'crossover_preview', mode: 'brew' },
        {
          platform: 'darwin',
          arch: 'arm64',
          darwinKernelMajor: 25,
          homedir,
          userDataDir,
          customApplicationsDir: targetAppsDir,
          applicationsDirs: [targetAppsDir],
          freeDiskBytes: 20 * 1024 * 1024 * 1024,
          skipProcessCheck: true,
          skipStagingCodesignVerify: true,
          verifySignatureFn: verifySignatureSpy,
          onExecDitto: async (src: string, dest: string) => {
            await fs.promises.cp(src, dest, { recursive: true, force: true });
          },
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, '', ''),
          onRunnerProgress: (evt: CompatibilityRunnerProgressEvent) => {
            if (recordedPhases[recordedPhases.length - 1] !== evt.phase) {
              recordedPhases.push(evt.phase);
            }
          },
          capturePreviewDownloadFn: async ({ destDir, progressCtx, options: hookOpts }: any) => {
            environmentProvisioner.emitEnvironmentSetupProgress(
              {
                ...progressCtx,
                phase: 'downloading',
                bytesDownloaded: 240 * 1024 * 1024,
                totalBytes: 480 * 1024 * 1024,
                progressPercent: 50,
                message: 'Downloading CrossOver Preview...',
              },
              hookOpts
            );
            const zipPath = path.join(destDir, 'CrossOver-Preview-20261015.zip');
            fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04SYNTHETIC-CX-PREVIEW-27.0.0-ZIP'));
            return { archivePath: zipPath, resolvedVersion: '20261015' };
          },
          onExtractArchive: async (_zipPath: string, stagingDir: string) => {
            seedPreviewBundle(stagingDir);
          },
        }
      );

      expect(installRes).toMatchObject({
        success: true,
        installed: true,
        runnerType: 'crossover_preview',
        installedPath: path.join(targetAppsDir, 'CrossOver Preview.app'),
      });
      expect(recordedPhases).toEqual(
        expect.arrayContaining([
          'downloading',
          'extracting',
          'verifying_signature',
          'installing',
          'completed',
        ])
      );
      expect(verifySignatureSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'app',
          expectedTeamIds: ['2C75U774H4'],
        }),
        expect.anything()
      );
      expect(fs.existsSync(path.join(targetAppsDir, 'CrossOver Preview.app'))).toBe(true);

      // Verify detectCompatibilityLayers reports semver '27.0.0' over the 8-digit preview date '20261015'
      const detectedAfterInstall = macNativeInstaller.detectCompatibilityLayers({
        platform: 'darwin',
        arch: 'arm64',
        homedir,
        applicationsDirs: [targetAppsDir],
      });
      const detectedPreview = detectedAfterInstall.find(
        (l: any) => l.type === 'crossover_preview'
      );
      expect(detectedPreview).toBeDefined();
      expect(detectedPreview.version).toBe('27.0.0');

      const receiptsPath = path.join(
        homedir,
        'Library/Application Support/OneLauncher/runner-install-receipts.json'
      );
      if (fs.existsSync(receiptsPath)) {
        const receiptsObj = JSON.parse(fs.readFileSync(receiptsPath, 'utf8'));
        for (const rec of Object.values(receiptsObj.receipts || {}) as any[]) {
          if (rec?.runnerType === 'crossover_preview') {
            expect(rec.releaseVersion).toBe('27.0.0');
            expect(rec.releaseVersion).not.toBe('20261015');
          }
        }
      }

      // Also verify Setup Wizard runEnvironmentSetupTasks installs crossover_preview cleanly when missing
      const wizardAppsDir = path.join(dir, 'WizardApplications');
      fs.mkdirSync(wizardAppsDir, { recursive: true });
      const wizardSetupRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          runId: 'run-preview-wizard-46',
          tasks: [
            {
              componentId: 'runner_crossover_preview',
              action: 'install_runner',
              runnerType: 'crossover_preview',
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          darwinKernelMajor: 25,
          homedir,
          userDataDir,
          customApplicationsDir: wizardAppsDir,
          applicationsDirs: [wizardAppsDir],
          rosettaInstalled: true,
          skipNetwork: false,
          freeDiskBytes: 20 * 1024 * 1024 * 1024,
          skipProcessCheck: true,
          skipStagingCodesignVerify: true,
          verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
          onExecDitto: async (src: string, dest: string) => {
            await fs.promises.cp(src, dest, { recursive: true, force: true });
          },
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, '', ''),
          capturePreviewDownloadFn: async ({ destDir }: any) => {
            const zipPath = path.join(destDir, 'CrossOver-Preview-20261015.zip');
            fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04SYNTHETIC-WIZARD-PREVIEW-ZIP'));
            return { archivePath: zipPath };
          },
          onExtractArchive: async (_zipPath: string, stagingDir: string) => {
            seedPreviewBundle(stagingDir);
          },
        }
      );
      expect(wizardSetupRes.success).toBe(true);
      expect(fs.existsSync(path.join(wizardAppsDir, 'CrossOver Preview.app'))).toBe(true);

      // 4. Tampered Developer ID (`TeamIdentifier=WRONGTEAM9`) fails closed & leaves target dir clean
      const tamperedAppsDir = path.join(dir, 'TamperedApplications');
      fs.mkdirSync(tamperedAppsDir, { recursive: true });
      const tamperedRes = await macNativeInstaller.installCompatibilityLayer(
        { runnerType: 'crossover_preview', mode: 'brew' },
        {
          platform: 'darwin',
          arch: 'arm64',
          darwinKernelMajor: 25,
          homedir,
          userDataDir,
          customApplicationsDir: tamperedAppsDir,
          applicationsDirs: [tamperedAppsDir],
          freeDiskBytes: 20 * 1024 * 1024 * 1024,
          skipProcessCheck: true,
          capturePreviewDownloadFn: async ({ destDir }: any) => {
            const zipPath = path.join(destDir, 'CrossOver-Preview-Tampered.zip');
            fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04TAMPERED-PREVIEW-ZIP'));
            return { archivePath: zipPath };
          },
          onExtractArchive: async (_zipPath: string, stagingDir: string) => {
            seedPreviewBundle(stagingDir);
          },
          execFileFn: (
            cmd: string,
            args: string[],
            _opts: any,
            cb: (err: any, stdout?: string, stderr?: string) => void
          ) => {
            if (cmd === '/usr/bin/codesign' && args.includes('-dv')) {
              cb(
                null,
                '',
                'Authority=Developer ID Application: Untrusted Publisher (WRONGTEAM9)\nTeamIdentifier=WRONGTEAM9\n'
              );
              return;
            }
            cb(null, '', '');
          },
        }
      );
      expect(tamperedRes.success).toBe(false);
      expect(tamperedRes.installed).toBe(false);
      expect(String(tamperedRes.error || tamperedRes.message)).toMatch(
        /TeamIdentifier mismatch.*WRONGTEAM9.*2C75U774H4/i
      );
      expect(fs.existsSync(path.join(tamperedAppsDir, 'CrossOver Preview.app'))).toBe(false);

      // 5. Window-close cancellation (`AbortError`) resolves cleanly with `{ success: false, cancelled: true, installed: false }`
      const cancelAppsDir = path.join(dir, 'CancelApplications');
      fs.mkdirSync(cancelAppsDir, { recursive: true });
      const cancelledRes = await macNativeInstaller.installCompatibilityLayer(
        { runnerType: 'crossover_preview', mode: 'brew' },
        {
          platform: 'darwin',
          arch: 'arm64',
          darwinKernelMajor: 25,
          homedir,
          userDataDir,
          customApplicationsDir: cancelAppsDir,
          applicationsDirs: [cancelAppsDir],
          freeDiskBytes: 20 * 1024 * 1024 * 1024,
          skipProcessCheck: true,
          capturePreviewDownloadFn: async () => {
            const abortErr = new Error('CodeWeavers Preview sign-in cancelled.');
            abortErr.name = 'AbortError';
            throw abortErr;
          },
        }
      );
      expect(cancelledRes).toMatchObject({
        success: false,
        cancelled: true,
        installed: false,
      });

      // 6. Direct `captureCodeWeaversPreviewDownload` BrowserWindow + `will-download` URL security guards
      const makeMockElectronForPreviewDownload = (downloadItemFactory: () => any) => {
        let willDownloadHandler: ((evt: any, item: any) => void) | null = null;
        let windowClosedListener: (() => void) | null = null;
        let destroyed = false;

        const mockSession = {
          on: vi.fn((evtName: string, cb: any) => {
            if (evtName === 'will-download') willDownloadHandler = cb;
          }),
          removeListener: vi.fn(),
        };

        class MockBrowserWindow {
          public webContents = {
            setWindowOpenHandler: vi.fn(),
            on: vi.fn(),
          };
          public isDestroyed() {
            return destroyed;
          }
          public close() {
            destroyed = true;
            if (windowClosedListener) windowClosedListener();
          }
          public on(evtName: string, cb: () => void) {
            if (evtName === 'closed') windowClosedListener = cb;
          }
          public async loadURL(_url: string) {
            if (willDownloadHandler) {
              const item = downloadItemFactory();
              willDownloadHandler({}, item);
            }
          }
        }

        return {
          electronMod: {
            BrowserWindow: MockBrowserWindow,
            session: {
              fromPartition: vi.fn(() => mockSession),
            },
          },
          wasWindowClosed: () => destroyed,
        };
      };

      const captureProgressCtx = {
        runId: 'capture-sec-46',
        componentId: 'runner_crossover_preview',
        stepIndex: 0,
        totalSteps: 1,
      };

      for (const blockedDownloadUrl of [
        'https://evil.example.com/CrossOverPreview.zip',
        'http://media.codeweavers.com/CrossOverPreview.zip',
      ]) {
        let itemCancelled = false;
        const mockEnv = makeMockElectronForPreviewDownload(() => ({
          getURL: () => blockedDownloadUrl,
          getURLChain: () => [blockedDownloadUrl],
          getFilename: () => 'CrossOverPreview.zip',
          cancel: () => {
            itemCancelled = true;
          },
          setSavePath: vi.fn(),
          on: vi.fn(),
          once: vi.fn(),
        }));

        await expect(
          environmentProvisioner.captureCodeWeaversPreviewDownload(
            path.join(dir, 'capture-blocked'),
            captureProgressCtx,
            {
              freeDiskBytes: 20 * 1024 * 1024 * 1024,
              electronMod: mockEnv.electronMod,
            }
          )
        ).rejects.toMatchObject({
          code: 'INSTALLER_URL_BLOCKED',
        });
        expect(itemCancelled).toBe(true);
        expect(mockEnv.wasWindowClosed()).toBe(true);
      }

      // Also verify untrusted initial `previewPortalUrl` is blocked before opening BrowserWindow
      const portalCheckEnv = makeMockElectronForPreviewDownload(() => ({}));
      await expect(
        environmentProvisioner.captureCodeWeaversPreviewDownload(
          path.join(dir, 'capture-blocked-portal'),
          captureProgressCtx,
          {
            freeDiskBytes: 20 * 1024 * 1024 * 1024,
            previewPortalUrl: 'https://evil.example.com/preview/download',
            electronMod: portalCheckEnv.electronMod,
          }
        )
      ).rejects.toMatchObject({
        code: 'INSTALLER_URL_BLOCKED',
      });
    });

    it('4.7 auto-discovers standard macOS CrossOver Preview link after sign-in, excludes experimental arm64 build, and closes popup immediately', async () => {
      const dir = makeTempDir('preview-portal-auto-capture-');

      // 1. Deterministic link selector strictly picks standard crossover-preview-<date>.zip over arm64 & Linux links
      expect(
        environmentProvisioner.isExperimentalArm64CrossOverPreviewTarget(
          'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261015.zip'
        )
      ).toBe(true);
      expect(
        environmentProvisioner.isExperimentalArm64CrossOverPreviewTarget(
          'https://www.codeweavers.com/preview/download/crossover-preview-20261015.zip'
        )
      ).toBe(false);

      const portalCandidateLinks = [
        // Experimental ARM64 listed FIRST on the page — must be skipped!
        '/preview/download/crossover-preview-arm64-20261015.zip',
        'https://www.codeweavers.com/preview/download/crossover-preview-aarch64-20261101.zip',
        // Linux & source links — must be skipped!
        '/preview/download/crossover-preview_27.0.0-1.deb',
        '/preview/download/crossover-preview-27.0.0-1.rpm',
        '/preview/download/install-crossover-preview-20261015.bin',
        'https://media.codeweavers.com/pub/crossover/source/crossover-sources-27.0.0.tar.gz',
        // Generic non-preview trial header link — must be skipped!
        'https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-26.3.0.zip',
        // Older standard Preview build
        '/preview/download/crossover-preview-20260920.zip',
        // Current standard macOS Preview build (WANTED!)
        '/preview/download/crossover-preview-20261015.zip',
      ];

      const chosenUrl = environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
        portalCandidateLinks,
        'https://www.codeweavers.com/preview/download'
      );
      expect(chosenUrl).toBe(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261015.zip'
      );

      // 2. Full post-login HTML portal flow: /preview/download -> 302 /login/ -> /account -> /preview/download HTML -> wc.downloadURL -> popup closed
      const runSimulatedPortalFlow = async (opts: { alreadyAuthenticated: boolean }) => {
        const destDir = path.join(
          dir,
          opts.alreadyAuthenticated ? 'cached-session' : 'interactive-login'
        );
        fs.mkdirSync(destDir, { recursive: true });

        let willDownloadHandler: ((evt: any, item: any) => void) | null = null;
        let windowClosedListener: (() => void) | null = null;
        const wcListeners = new Map<string, Array<(...args: any[]) => void>>();
        let currentUrl = '';
        let windowShownCount = 0;
        let windowHidden = false;
        let windowDestroyed = false;
        const downloadedUrls: string[] = [];

        const emitWc = (evt: string, ...args: any[]) => {
          for (const fn of wcListeners.get(evt) || []) {
            fn(...args);
          }
        };

        const mockSession = {
          on: vi.fn((evtName: string, cb: any) => {
            if (evtName === 'will-download') willDownloadHandler = cb;
          }),
          removeListener: vi.fn(),
        };

        const triggerSimulatedDownloadItem = (targetUrl: string) => {
          downloadedUrls.push(targetUrl);
          let savedPath = '';
          let doneCb: ((evt: any, state: string) => void) | null = null;
          const filename = path.basename(new URL(targetUrl).pathname);
          const item = {
            getURL: () => targetUrl,
            getURLChain: () => [targetUrl],
            getFilename: () => filename,
            getTotalBytes: () => 480 * 1024 * 1024,
            getReceivedBytes: () => 480 * 1024 * 1024,
            cancel: vi.fn(),
            setSavePath: (p: string) => {
              savedPath = p;
            },
            on: vi.fn((evtName: string, cb: any) => {
              if (evtName === 'done') doneCb = cb;
            }),
            once: vi.fn((evtName: string, cb: any) => {
              if (evtName === 'done') doneCb = cb;
            }),
          };
          willDownloadHandler!({}, item);
          if (savedPath && doneCb) {
            fs.writeFileSync(savedPath, Buffer.from('PK\x03\x04STANDARD-PREVIEW-BUILD'));
            setImmediate(() => doneCb!({}, 'completed'));
          }
        };

        let authenticated = opts.alreadyAuthenticated;

        class MockPortalBrowserWindow {
          public webContents = {
            setWindowOpenHandler: vi.fn(),
            on: vi.fn((evtName: string, cb: (...args: any[]) => void) => {
              const list = wcListeners.get(evtName) || [];
              list.push(cb);
              wcListeners.set(evtName, list);
            }),
            getURL: () => currentUrl,
            executeJavaScript: vi.fn(async () => {
              if (!authenticated || currentUrl.includes('/login')) {
                return { hrefs: ['/login/forgot'], hasPasswordInput: true };
              }
              if (currentUrl.endsWith('/account')) {
                return { hrefs: ['/account/orders', '/preview'], hasPasswordInput: false };
              }
              // Authenticated /preview/download HTML page with BOTH arm64 and standard zip links!
              return {
                hrefs: [
                  'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261015.zip',
                  'https://www.codeweavers.com/preview/download/crossover-preview-20261015.zip',
                  'https://www.codeweavers.com/preview/download/crossover-preview_27.0.0-1.deb',
                ],
                hasPasswordInput: false,
              };
            }),
            downloadURL: vi.fn((targetUrl: string) => {
              triggerSimulatedDownloadItem(targetUrl);
            }),
          };

          constructor(winOpts: any) {
            if (winOpts?.show) windowShownCount += 1;
          }

          public show() {
            windowShownCount += 1;
          }
          public focus() {}
          public hide() {
            windowHidden = true;
          }
          public isDestroyed() {
            return windowDestroyed;
          }
          public close() {
            windowDestroyed = true;
            if (windowClosedListener) windowClosedListener();
          }
          public destroy() {
            windowDestroyed = true;
            if (windowClosedListener) windowClosedListener();
          }
          public on(evtName: string, cb: () => void) {
            if (evtName === 'closed') windowClosedListener = cb;
          }
          public async loadURL(url: string) {
            if (!authenticated && url.includes('/preview/download')) {
              currentUrl = 'https://www.codeweavers.com/login/';
              emitWc('will-redirect', {}, currentUrl);
              emitWc('did-navigate', {}, currentUrl);
              emitWc('did-finish-load');
              // Simulate user completing sign-in and CodeWeavers redirecting to /account
              setImmediate(() => {
                authenticated = true;
                currentUrl = 'https://www.codeweavers.com/account';
                emitWc('did-navigate', {}, currentUrl);
                emitWc('did-finish-load');
              });
              return;
            }
            currentUrl = url;
            emitWc('did-navigate', {}, currentUrl);
            emitWc('did-finish-load');
          }
        }

        const captureRes = await environmentProvisioner.captureCodeWeaversPreviewDownload(
          destDir,
          {
            runId: 'portal-flow-47',
            componentId: 'runner_crossover_preview',
            stepIndex: 0,
            totalSteps: 1,
          },
          {
            freeDiskBytes: 20 * 1024 * 1024 * 1024,
            electronMod: {
              BrowserWindow: MockPortalBrowserWindow,
              session: {
                fromPartition: vi.fn(() => mockSession),
              },
            },
          }
        );

        await new Promise((r) => setImmediate(r));
        return {
          captureRes,
          downloadedUrls,
          windowShownCount,
          windowHidden,
          windowDestroyed,
        };
      };

      // Scenario A: Interactive login -> shown on /login -> auto-navigates to /preview/download -> picks non-arm64 -> closes popup!
      const interactiveRes = await runSimulatedPortalFlow({ alreadyAuthenticated: false });
      expect(interactiveRes.downloadedUrls).toEqual([
        'https://www.codeweavers.com/preview/download/crossover-preview-20261015.zip',
      ]);
      expect(interactiveRes.windowShownCount).toBeGreaterThanOrEqual(1);
      expect(interactiveRes.windowHidden).toBe(true);
      expect(interactiveRes.windowDestroyed).toBe(true);
      expect(interactiveRes.captureRes.resolvedVersion).toBe('20261015');
      expect(fs.existsSync(interactiveRes.captureRes.archivePath)).toBe(true);

      // Scenario B: Cached session in `persist:codeweavers-preview` -> silent capture with 0 popup flash!
      const cachedRes = await runSimulatedPortalFlow({ alreadyAuthenticated: true });
      expect(cachedRes.downloadedUrls).toEqual([
        'https://www.codeweavers.com/preview/download/crossover-preview-20261015.zip',
      ]);
      expect(cachedRes.windowShownCount).toBe(0);
      expect(cachedRes.windowDestroyed).toBe(true);
      expect(cachedRes.captureRes.resolvedVersion).toBe('20261015');
    });
  });
});
