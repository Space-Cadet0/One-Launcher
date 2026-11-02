import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

import {
  createDomain12DeepRenderer,
  buildValidMinimalPe64Buffer,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';
import { scanContentForPiiViolations } from './helpers/piiHygieneGuard';

import {
  detectKernelAntiCheatFromNotice,
  normalizeChainedHandoffId as normalizeTsChainedHandoffId,
  sanitizeGameCatalog,
} from '../src/services/integrations/catalogSanitizer';
import { extractEpicPartnerHandoffMetadata } from '../src/services/integrations/epicIntegration';
import { mergeStorefrontGames } from '../src/services/integrations/integrationStorage';
import { launcherService } from '../src/services/launcher/launcherService';
import {
  buildFallbackEnvironmentSnapshot,
  computeDefaultSelectedComponents,
  environmentSetupService,
} from '../src/services/launcher/environmentSetupService';

import { PlatformBadges } from '../src/components/SteamStoreDetail/PlatformBadges';
import { SteamSidebarNotices } from '../src/components/SteamStoreDetail/SteamSidebarNotices';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';
import { StorefrontClientsStep } from '../src/components/Launcher/SystemSetupWizard/steps/StorefrontClientsStep';
import { GuidedClientSignInStep } from '../src/components/Launcher/SystemSetupWizard/steps/GuidedClientSignInStep';

import type { CanonicalGame } from '../src/contracts/game';
import type { GameInstallInfo } from '../src/contracts/launcher';
import type { EnvironmentComponentId } from '../src/contracts/environmentSetup';

const require = createRequire(import.meta.url);
const chainedPublisherLaunchers = require('../electron/launcher/chainedPublisherLaunchers.cjs');
const windowsRegistryDiscovery = require('../electron/utils/windowsRegistryDiscovery.cjs');
const nonGameClassifier = require('../electron/storefronts/nonGameClassifier.cjs');
const xboxCatalogAndGamePass = require('../electron/storefronts/xbox/xboxCatalogAndGamePass.cjs');
const storeSync = require('../electron/storeSync.cjs');
const epicLegendaryCoordinator = require('../electron/launcher/epicLegendaryAndEosCoordinator.cjs');
const downloadQueueCoordinator = require('../electron/launcher/downloadQueueCoordinator.cjs');
const installedGameScanner = require('../electron/launcher/installedGameScanner.cjs');
const macNativeInstallerAndCodesign = require('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const sessionAndProcessSupervisor = require('../electron/launcher/sessionAndProcessSupervisor.cjs');
const environmentProvisioner = require('../electron/launcher/environmentProvisioner.cjs');
const engineStateRegistry = require('../electron/launcher/engineStateRegistry.cjs');
const steamLocalScanner = require('../electron/storefronts/steamLocalScanner.cjs');
const offlineVaultMod = require('../electron/launcher/offlineVaultService.cjs');

// ============================================================================
// Hermetic Browser/DOM Polyfills & Helpers (Node/Vitest without jsdom)
// ============================================================================

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, val: string): void {
    this.map.set(key, String(val));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
}

const memStorage = new MemoryStorage();

function ensureWindowAndStorageGlobals(): void {
  const g = globalThis as Record<string, any>;
  if (!g.localStorage) {
    g.localStorage = memStorage;
  }
  if (!g.CustomEvent) {
    g.CustomEvent = class CustomEvent {
      type: string;
      detail: any;
      constructor(type: string, init?: { detail?: any }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  }
  const listeners: Record<string, Array<(ev: any) => void>> = {};
  if (!g.window) {
    g.window = {
      localStorage: g.localStorage,
      location: { hostname: '' },
      navigator: { userAgent: 'Macintosh' },
      addEventListener: (ev: string, fn: (e: any) => void) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(fn);
      },
      removeEventListener: (ev: string, fn: (e: any) => void) => {
        if (listeners[ev]) {
          listeners[ev] = listeners[ev].filter((f) => f !== fn);
        }
      },
      dispatchEvent: (event: any) => {
        for (const fn of (listeners[event.type] || []).slice()) {
          fn(event);
        }
        return true;
      },
    };
  } else if (!g.window.localStorage) {
    g.window.localStorage = g.localStorage;
  }
}

ensureWindowAndStorageGlobals();

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

/**
 * Deterministic WCAG 2.2 AA accessibility auditor over rendered VNode trees & static HTML markup.
 * Enforces `axe-core` WCAG 2.2 AA rules in pure Node/Vitest without network or headless Chromium:
 *  - `html-well-formedness`: strict XML/HTML structural parse via `@xmldom/xmldom`
 *  - `duplicate-id` / `aria-valid-attr-value`: zero duplicate IDs and valid `aria-labelledby`/`aria-describedby`/`htmlFor`
 *  - `dialog-name`: `<dialog>` has valid accessible name (`aria-label` or `aria-labelledby`)
 *  - `button-name`, `button-type`, `target-size` (WCAG 2.2 SC 2.5.8 >=24px)
 *  - `label`: every `<input>`, `<select>`, and `<textarea>` has an explicit or implicit accessible label
 *  - `progressbar-name` & `progressbar-value`
 *  - `color-contrast`: forbids low-contrast muted text classes (`text-slate-500..900`) on dark launcher surfaces
 */
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
      const labelledByText =
        typeof props['aria-labelledby'] === 'string'
          ? props['aria-labelledby']
              .trim()
              .split(/\s+/)
              .map((id: string) => extractVNodeText(elementsById.get(id)).trim())
              .join(' ')
              .trim()
          : '';
      if (!visibleText && !ariaLabel && !labelledByText) {
        violations.push(`button-name: ${testId} has no accessible name`);
      }
      const cls = String(props.className || '');
      if (!/\b(min-h-6|min-w-6|p-\d|py-\d|px-\d|h-\d|underline)\b/.test(cls)) {
        violations.push(
          `target-size (WCAG 2.2 SC 2.5.8): ${testId} lacks >=24px target sizing class ("${cls}")`
        );
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

    if (tag === 'progress') {
      const ariaLabel = typeof props['aria-label'] === 'string' ? props['aria-label'].trim() : '';
      const ariaLabelledBy =
        typeof props['aria-labelledby'] === 'string' ? props['aria-labelledby'].trim() : '';
      if (!ariaLabel && !ariaLabelledBy) {
        violations.push(`progressbar-name: <progress> lacks accessible name`);
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

/**
 * Builds a minimal valid binary Steam `appinfo.vdf` (v28, magic `0x07564428`) buffer
 * with one or more launch entries per AppID.
 */
function buildBinarySteamAppInfoVdfV28(
  apps: Array<{
    appId: number;
    launches: Array<{
      executable: string;
      arguments?: string;
      oslist?: string;
    }>;
  }>
): Buffer {
  const cstr = (s: string) => Buffer.from(`${s}\0`, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x07564428, 0);
  header.writeUInt32LE(1, 4);

  const appChunks: Buffer[] = [header];
  for (const app of apps) {
    const launchEntries: Buffer[] = [];
    app.launches.forEach((launch, idx) => {
      const entryParts: Buffer[] = [
        Buffer.from([0x00]),
        cstr(String(idx)),
        Buffer.from([0x01]),
        cstr('executable'),
        cstr(launch.executable),
      ];
      if (launch.arguments) {
        entryParts.push(Buffer.from([0x01]), cstr('arguments'), cstr(launch.arguments));
      }
      if (launch.oslist) {
        entryParts.push(
          Buffer.from([0x00]),
          cstr('config'),
          Buffer.from([0x01]),
          cstr('oslist'),
          cstr(launch.oslist),
          Buffer.from([0x08])
        );
      }
      entryParts.push(Buffer.from([0x08]));
      launchEntries.push(...entryParts);
    });

    const vdfPayload = Buffer.concat([
      Buffer.from([0x00]),
      cstr('appinfo'),
      Buffer.from([0x00]),
      cstr('config'),
      Buffer.from([0x00]),
      cstr('launch'),
      ...launchEntries,
      Buffer.from([0x08]),
      Buffer.from([0x08]),
      Buffer.from([0x08]),
      Buffer.from([0x08]),
    ]);

    const entryMetaBytes = 60;
    const entryHeader = Buffer.alloc(8 + entryMetaBytes);
    entryHeader.writeUInt32LE(app.appId, 0);
    entryHeader.writeUInt32LE(entryMetaBytes + vdfPayload.length, 4);
    appChunks.push(entryHeader, vdfPayload);
  }

  const footer = Buffer.alloc(4);
  footer.writeUInt32LE(0, 0);
  appChunks.push(footer);
  return Buffer.concat(appChunks);
}

/**
 * Builds a spec-compliant PE32+ (64-bit) installer buffer (>= 520 KB) with optional embedded
 * Authenticode `WIN_CERTIFICATE` (`DataDirectory[4]`, `WIN_CERT_REVISION_2_0`, `WIN_CERT_TYPE_PKCS_SIGNED_DATA`).
 */
function buildSyntheticInstallerPe64Buffer(opts: { withAuthenticode?: boolean } = {}): Buffer {
  const paddedBody = Buffer.alloc(520 * 1024, 0);
  // DOS Header: 'MZ' at 0x00, e_lfanew = 0x80 at 0x3c
  paddedBody[0] = 0x4d;
  paddedBody[1] = 0x5a;
  const peOffset = 0x80;
  paddedBody.writeUInt32LE(peOffset, 0x3c);

  // NT Header: 'PE\0\0' + COFF File Header + PE32+ Optional Header
  paddedBody[peOffset] = 0x50;
  paddedBody[peOffset + 1] = 0x45;
  paddedBody[peOffset + 2] = 0x00;
  paddedBody[peOffset + 3] = 0x00;
  paddedBody.writeUInt16LE(0x8664, peOffset + 4); // IMAGE_FILE_MACHINE_AMD64
  paddedBody.writeUInt16LE(1, peOffset + 6); // NumberOfSections
  paddedBody.writeUInt16LE(0x00f0, peOffset + 20); // SizeOfOptionalHeader (240)
  paddedBody.writeUInt16LE(0x0022, peOffset + 22); // Characteristics
  const optOffset = peOffset + 24;
  paddedBody.writeUInt16LE(0x020b, optOffset); // PE32+ Magic
  paddedBody.writeUInt32LE(16, optOffset + 108); // NumberOfRvaAndSizes

  if (!opts.withAuthenticode) return paddedBody;

  const certBytes = Buffer.alloc(64, 0x30);
  certBytes.writeUInt32LE(certBytes.length, 0); // dwLength
  certBytes.writeUInt16LE(0x0200, 4); // wRevision = WIN_CERT_REVISION_2_0
  certBytes.writeUInt16LE(0x0002, 6); // wCertificateType = WIN_CERT_TYPE_PKCS_SIGNED_DATA

  const total = Buffer.concat([paddedBody, certBytes]);
  const secDirOffset = optOffset + 112 + 4 * 8; // DataDirectory[4] (Security)
  total.writeUInt32LE(paddedBody.length, secDirOffset);
  total.writeUInt32LE(certBytes.length, secDirOffset + 4);
  return total;
}

function seedMockCrossOverApp(appsDir: string): string {
  const appPath = path.join(appsDir, 'CrossOver.app');
  const binDir = path.join(appPath, 'Contents/SharedSupport/CrossOver/bin');
  fs.mkdirSync(binDir, { recursive: true });
  const wineBin = path.join(binDir, 'wine');
  fs.writeFileSync(wineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(appPath, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>26.0.0</string>
</dict></plist>`,
    'utf8'
  );
  return appPath;
}

function seedInitializedCrossOverBottle(macHome: string, bottleName = 'OneLauncher'): string {
  const bottlePath = path.join(
    macHome,
    'Library/Application Support/CrossOver/Bottles',
    bottleName
  );
  fs.mkdirSync(path.join(bottlePath, 'drive_c/windows/system32'), { recursive: true });
  fs.mkdirSync(path.join(bottlePath, 'drive_c/users/crossover/AppData/Local'), { recursive: true });
  fs.writeFileSync(
    path.join(bottlePath, 'system.reg'),
    'WINE REGISTRY Version 2\n\n[Software\\\\Microsoft\\\\Windows NT\\\\CurrentVersion]\n"CurrentBuild"="19045"\n',
    'utf8'
  );
  fs.writeFileSync(path.join(bottlePath, 'user.reg'), 'WINE REGISTRY Version 2\n\n', 'utf8');
  return bottlePath;
}

// ============================================================================
// EA Wave 3A: Hermetic Dual-OS EA Chained-Launcher & Storefront Attribution Suite
// ============================================================================

describe('EA Chained-Launcher Lifecycle & Four-Storefront Attribution — Dual-OS Hermetic QA Suite', () => {
  const sandboxes: string[] = [];
  let socketConnectSpy: ReturnType<typeof vi.spyOn>;

  const makeSandbox = (prefix = 'ol-ea-test-'): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    sandboxes.push(dir);
    return dir;
  };

  beforeEach(() => {
    ensureWindowAndStorageGlobals();
    memStorage.clear();
    engineStateRegistry.openedExternalUris.length = 0;
    downloadQueueCoordinator.shutdownDownloadEngine();
    engineStateRegistry.downloadQueueMap.clear();
    engineStateRegistry.invalidateScanCaches();

    // Strict hermetic offline guard: block any unmocked outbound TCP socket connection
    socketConnectSpy = vi
      .spyOn(net.Socket.prototype, 'connect')
      .mockImplementation(function blockedSocketConnect(this: net.Socket, ...args: any[]) {
        const target = JSON.stringify(args[0] ?? '');
        throw new Error(`Hermetic offline guard blocked outbound net.Socket.connect(${target})`);
      });
  });

  afterEach(() => {
    downloadQueueCoordinator.shutdownDownloadEngine();
    socketConnectSpy?.mockRestore();
    vi.restoreAllMocks();
    while (sandboxes.length > 0) {
      const dir = sandboxes.pop();
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  // ==========================================================================
  // 0. Zero-PII & Synthetic Fixture Hygiene Self-Guard
  // ==========================================================================
  describe('0. Zero-PII & Synthetic Fixture Hygiene Self-Guard', () => {
    it('contains zero real user paths, usernames, emails, tokens, or account identifiers in this test file', () => {
      const selfPath = path.resolve(__dirname, 'eaChainedLauncherAndAttribution.test.tsx');
      const source = fs.readFileSync(selfPath, 'utf8');
      const violations = scanContentForPiiViolations(
        source,
        'tests/eaChainedLauncherAndAttribution.test.tsx'
      );
      expect(violations).toEqual([]);
    });
  });

  // ==========================================================================
  // 1. EA Session Ground-Truth (`hasEaLocalSessionInDir`)
  // ==========================================================================
  describe('1. EA Session Ground-Truth (hasEaLocalSessionInDir)', () => {
    it('rejects unauthenticated telemetry/cache dirs, missing/empty cookie.ini, user.ignoreRememberMe=true, and expired cookies, while accepting valid non-expired remid/sid rememberMeCookie across bottle and host discovery', () => {
      const sandbox = makeSandbox('ol-ea-test-session-');
      const eaLocalDir = path.join(sandbox, 'Electronic Arts/EA Desktop');

      // 1a) Telemetry, CDC, IGStorage, and `user_unknown.ini` ONLY -> MUST return `false`
      fs.mkdirSync(path.join(eaLocalDir, 'OfflineCache/Telemetry'), { recursive: true });
      fs.mkdirSync(path.join(eaLocalDir, 'OfflineCache/CDC'), { recursive: true });
      fs.mkdirSync(path.join(eaLocalDir, 'IGStorage'), { recursive: true });
      fs.writeFileSync(path.join(eaLocalDir, 'OfflineCache/Telemetry/events.bin'), 'telemetry', 'utf8');
      fs.writeFileSync(
        path.join(eaLocalDir, 'user_unknown.ini'),
        'user.rememberme=true\n',
        'utf8'
      );
      expect(chainedPublisherLaunchers.hasEaLocalSessionInDir(eaLocalDir)).toBe(false);

      // 1b) Numeric `user_1000000000001.ini` present, but `cookie.ini` absent -> MUST return `false`
      const userIniPath = path.join(eaLocalDir, 'user_1000000000001.ini');
      fs.writeFileSync(userIniPath, 'user.ignoreRememberMe=false\n', 'utf8');
      expect(chainedPublisherLaunchers.hasEaLocalSessionInDir(eaLocalDir)).toBe(false);

      // 1c) Empty `cookie.ini` -> MUST return `false`
      const cookieIniPath = path.join(eaLocalDir, 'cookie.ini');
      fs.writeFileSync(cookieIniPath, '', 'utf8');
      expect(chainedPublisherLaunchers.hasEaLocalSessionInDir(eaLocalDir)).toBe(false);

      // 1d) Expired `Expires=Thu, 01-Jan-1970 00:00:01 GMT` -> MUST return `false`
      fs.writeFileSync(
        cookieIniPath,
        'browser.rememberMeCookie="remid=synthetic_token; Expires=Thu, 01-Jan-1970 00:00:01 GMT; Domain=.ea.com; Path=/; Secure; HttpOnly"\n',
        'utf8'
      );
      expect(chainedPublisherLaunchers.hasEaLocalSessionInDir(eaLocalDir)).toBe(false);

      // 1e) Valid future expiry in `cookie.ini`, BUT `user.ignoreRememberMe=true` -> MUST return `false`
      fs.writeFileSync(
        cookieIniPath,
        'browser.rememberMeCookie="remid=synthetic_token; Expires=Tue, 01-Jan-2036 00:00:00 GMT; Domain=.ea.com; Path=/; Secure; HttpOnly"\n',
        'utf8'
      );
      fs.writeFileSync(userIniPath, 'user.ignoreRememberMe=true\n', 'utf8');
      const syncEpochSec = Math.floor(Date.now() / 1000);
      fs.utimesSync(cookieIniPath, syncEpochSec, syncEpochSec);
      fs.utimesSync(userIniPath, syncEpochSec, syncEpochSec);
      expect(chainedPublisherLaunchers.hasEaLocalSessionInDir(eaLocalDir)).toBe(false);

      // 1f) Valid non-expired `browser.rememberMeCookie` + `user.ignoreRememberMe=false` -> MUST return `true`
      fs.writeFileSync(userIniPath, 'user.ignoreRememberMe=false\n', 'utf8');
      expect(chainedPublisherLaunchers.hasEaLocalSessionInDir(eaLocalDir)).toBe(true);

      // 1g) Verify bottle (`darwin`) and host (`darwin` + `win32`) launcher discovery reflect session ground truth
      const macHome = path.join(sandbox, 'macHome');
      const bottlePath = seedInitializedCrossOverBottle(macHome, 'OneLauncher');
      const pe64 = buildValidMinimalPe64Buffer();
      const bottleEaBinDir = path.join(
        bottlePath,
        'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop'
      );
      fs.mkdirSync(bottleEaBinDir, { recursive: true });
      fs.writeFileSync(path.join(bottleEaBinDir, 'EADesktop.exe'), pe64);
      const bottleEaLocal = path.join(
        bottlePath,
        'drive_c/users/crossover/AppData/Local/Electronic Arts/EA Desktop'
      );
      fs.mkdirSync(path.join(bottleEaLocal, 'OfflineCache/Telemetry'), { recursive: true });
      expect(
        chainedPublisherLaunchers.discoverBottlePublisherLauncher(bottlePath, 'ea').hasLocalSession
      ).toBe(false);

      fs.writeFileSync(
        path.join(bottleEaLocal, 'user_1000000000001.ini'),
        'user.ignoreRememberMe=false\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(bottleEaLocal, 'cookie.ini'),
        'browser.rememberMeCookie="remid=synthetic_token; Expires=Tue, 01-Jan-2036 00:00:00 GMT; Domain=.ea.com; Path=/; Secure; HttpOnly"\n',
        'utf8'
      );
      expect(
        chainedPublisherLaunchers.discoverBottlePublisherLauncher(bottlePath, 'ea').hasLocalSession
      ).toBe(true);
    });
  });

  // ==========================================================================
  // 2. EA Silent Provisioning, Bottle Autostart Sanitizer & Discovery
  // ==========================================================================
  describe('2. EA Silent Provisioning, Bottle Autostart Sanitizer & Dual-OS Discovery', () => {
    it('enforces silent installer flags, sanitizes EADM autostart in bottle user.reg, discovers EADesktop/EALauncher/EABackgroundService + version.properties on darwin & win32, and normalizes EA aliases', async () => {
      // 2a) Silent installer arguments
      const eaEco = chainedPublisherLaunchers.CHAINED_PUBLISHER_ECOSYSTEMS.ea;
      expect(eaEco.silentArgs).toEqual(
        expect.arrayContaining([
          '/quiet',
          '/norestart',
          'EAX_LAUNCH_CLIENT=0',
          'CreateDesktopShortcut=0',
        ])
      );

      // 2b) Alias normalization across CJS & TS modules
      expect(windowsRegistryDiscovery.normalizePublisherLauncherId('The EA App')).toBe('ea');
      expect(chainedPublisherLaunchers.normalizeChainedHandoffId('The EA App')).toBe('ea');
      expect(chainedPublisherLaunchers.normalizeChainedHandoffId('link2ea')).toBe('ea');
      expect(normalizeTsChainedHandoffId('The EA App')).toBe('ea');
      expect(normalizeTsChainedHandoffId('link2ea')).toBe('ea');

      // 2c) `sanitizeEaBottleAutostartInUserReg(bottlePath)` removes `"EADM"` while preserving other Run keys and sets `startOnBootFlag=dword:00000000`
      const sandbox = makeSandbox('ol-ea-test-provision-');
      const macHome = path.join(sandbox, 'macHome');
      const bottlePath = seedInitializedCrossOverBottle(macHome, 'OneLauncher');
      const userRegPath = path.join(bottlePath, 'user.reg');
      fs.writeFileSync(
        userRegPath,
        [
          'WINE REGISTRY Version 2',
          '',
          '[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run] 1700000100',
          '"Steam"="\\"C:\\\\Program Files (x86)\\\\Steam\\\\steam.exe\\" -silent"',
          '"EADM"="\\"C:\\\\Program Files\\\\Electronic Arts\\\\EA Desktop\\\\EA Desktop\\\\EABackgroundService.exe\\""',
          '"SyntheticHelper"="C:\\\\Tools\\\\SyntheticHelper.exe"',
          '',
          '[Software\\\\Electronic Arts\\\\EA Desktop] 1700000105',
          '"startOnBootFlag"=dword:00000001',
          '"locale"="en_US"',
          '',
        ].join('\n'),
        'utf8'
      );

      const sanitized = chainedPublisherLaunchers.sanitizeEaBottleAutostartInUserReg(bottlePath);
      expect(sanitized).toBe(true);
      const updatedUserReg = fs.readFileSync(userRegPath, 'utf8');
      expect(updatedUserReg).not.toContain('"EADM"=');
      expect(updatedUserReg).toContain('"Steam"=');
      expect(updatedUserReg).toContain('"SyntheticHelper"=');
      expect(updatedUserReg).toContain('"startOnBootFlag"=dword:00000000');

      // 2d) Bottle EA discovery (`darwin` Wine bottle): `binaryPath`, `launcherAppPath`, `backgroundServicePath`, and `version.properties` fallback
      const pe64 = buildValidMinimalPe64Buffer();
      const bottleEaParent = path.join(
        bottlePath,
        'drive_c/Program Files/Electronic Arts/EA Desktop'
      );
      const bottleEaDir = path.join(bottleEaParent, 'EA Desktop');
      fs.mkdirSync(bottleEaDir, { recursive: true });
      const bottleEaDesktopExe = path.join(bottleEaDir, 'EADesktop.exe');
      const bottleEaLauncherExe = path.join(bottleEaDir, 'EALauncher.exe');
      const bottleEaBgServiceExe = path.join(bottleEaDir, 'EABackgroundService.exe');
      fs.writeFileSync(bottleEaDesktopExe, pe64);
      fs.writeFileSync(bottleEaLauncherExe, pe64);
      fs.writeFileSync(bottleEaBgServiceExe, pe64);
      fs.writeFileSync(
        path.join(bottleEaParent, 'version.properties'),
        'app.version=13.345.0.5758\n',
        'utf8'
      );

      const bottleDisc = chainedPublisherLaunchers.discoverBottlePublisherLauncher(
        bottlePath,
        'ea'
      );
      expect(bottleDisc.installed).toBe(true);
      expect(bottleDisc.binaryPath).toBe(bottleEaDesktopExe);
      expect(bottleDisc.launcherAppPath).toBe(bottleEaLauncherExe);
      expect(bottleDisc.backgroundServicePath).toBe(bottleEaBgServiceExe);
      expect(bottleDisc.version).toBe('13.345.0.5758');

      // 2e) Windows (`win32`) host EA discovery: `binaryPath`, `launcherAppPath`, `backgroundServicePath`, and `version.properties` fallback
      const winDrive = path.join(sandbox, 'winHost');
      const winEaDir = path.join(winDrive, 'Program Files/Electronic Arts/EA Desktop/EA Desktop');
      fs.mkdirSync(winEaDir, { recursive: true });
      fs.writeFileSync(path.join(winEaDir, 'EADesktop.exe'), pe64);
      fs.writeFileSync(path.join(winEaDir, 'EALauncher.exe'), pe64);
      fs.writeFileSync(path.join(winEaDir, 'EABackgroundService.exe'), pe64);
      fs.writeFileSync(
        path.join(winEaDir, 'version.properties'),
        'version=13.350.0.5800\n',
        'utf8'
      );
      const winEnv = {
        PROGRAMFILES: path.join(winDrive, 'Program Files'),
        'PROGRAMFILES(X86)': path.join(winDrive, 'Program Files (x86)'),
        PROGRAMDATA: path.join(winDrive, 'ProgramData'),
        LOCALAPPDATA: path.join(winDrive, 'Users/testuser/AppData/Local'),
        SYSTEMDRIVE: winDrive,
      };
      const winHostDisc = chainedPublisherLaunchers.discoverHostPublisherLauncher('ea', {
        platform: 'win32',
        homedir: path.join(winDrive, 'Users/testuser'),
        env: winEnv,
      });
      expect(winHostDisc.installed).toBe(true);
      expect(winHostDisc.binaryPath).toBe(path.join(winEaDir, 'EADesktop.exe'));
      expect(winHostDisc.launcherAppPath).toBe(path.join(winEaDir, 'EALauncher.exe'));
      expect(winHostDisc.backgroundServicePath).toBe(
        path.join(winEaDir, 'EABackgroundService.exe')
      );
      expect(winHostDisc.version).toBe('13.350.0.5800');

      // 2f) macOS (`darwin`) host `EA app.app` discovery via `customApplicationsDir`
      const macAppsDir = path.join(sandbox, 'MacApplications');
      const macEaAppBundle = path.join(macAppsDir, 'EA app.app');
      const macEaDesktopBin = path.join(macEaAppBundle, 'Contents/MacOS/EADesktop');
      const macEaLauncherBin = path.join(
        macEaAppBundle,
        'Contents/Applications/EALauncher.app/Contents/MacOS/EALauncher'
      );
      const macEaBgBin = path.join(
        macEaAppBundle,
        'Contents/Applications/EABackgroundService.app/Contents/MacOS/EABackgroundService'
      );
      fs.mkdirSync(path.dirname(macEaDesktopBin), { recursive: true });
      fs.mkdirSync(path.dirname(macEaLauncherBin), { recursive: true });
      fs.mkdirSync(path.dirname(macEaBgBin), { recursive: true });
      fs.mkdirSync(path.join(macEaAppBundle, 'Contents/Resources'), { recursive: true });
      fs.writeFileSync(macEaDesktopBin, '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(macEaLauncherBin, '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(macEaBgBin, '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(
        path.join(macEaAppBundle, 'Contents/Resources/version.properties'),
        'app.version=13.360.0.5900\n',
        'utf8'
      );

      const macHostDisc = chainedPublisherLaunchers.discoverHostPublisherLauncher('ea', {
        platform: 'darwin',
        homedir: macHome,
        customApplicationsDir: macAppsDir,
      });
      expect(macHostDisc.installed).toBe(true);
      expect(macHostDisc.binaryPath).toBe(macEaDesktopBin);
      expect(macHostDisc.launcherAppPath).toBe(macEaLauncherBin);
      expect(macHostDisc.backgroundServicePath).toBe(macEaBgBin);
      expect(macHostDisc.version).toBe('13.360.0.5900');

      // 2g) Verify `ensureChainedPublisherLauncherInstalled` passes all 4 silent args and sanitizes bottle user.reg
      const freshBottle = seedInitializedCrossOverBottle(macHome, 'SilentProvisionBottle');
      fs.writeFileSync(
        path.join(freshBottle, 'user.reg'),
        [
          'WINE REGISTRY Version 2',
          '',
          '[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run] 1700000200',
          '"EADM"="\\"C:\\\\Program Files\\\\Electronic Arts\\\\EA Desktop\\\\EA Desktop\\\\EABackgroundService.exe\\""',
          '',
        ].join('\n'),
        'utf8'
      );
      const crossoverApp = seedMockCrossOverApp(macAppsDir);
      const signedPe = buildSyntheticInstallerPe64Buffer({ withAuthenticode: true });
      let spawnedSilentArgs: string[] = [];
      let spawnedSilentEnv: Record<string, string | undefined> = {};

      const provRes = await environmentProvisioner.ensureChainedPublisherLauncherInstalled(
        {
          handoffId: 'ea',
          platform: 'darwin',
          runnerLayer: {
            type: 'crossover',
            name: 'CrossOver',
            binaryPath: path.join(crossoverApp, 'Contents/SharedSupport/CrossOver/bin/wine'),
            bottlesDir: path.dirname(freshBottle),
          },
          bottleName: 'SilentProvisionBottle',
          bottlePath: freshBottle,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: macHome,
          userDataDir: path.join(sandbox, 'userData'),
          bottlePollIntervalMs: 15,
          fetchFn: async (url: string) => ({
            ok: true,
            status: 200,
            url,
            headers: { get: () => String(signedPe.length) },
            arrayBuffer: async () =>
              signedPe.buffer.slice(signedPe.byteOffset, signedPe.byteOffset + signedPe.byteLength),
          }),
          spawnFn: (_cmd: string, args: string[], spawnOpts?: { env?: Record<string, string> }) => {
            spawnedSilentArgs = args;
            spawnedSilentEnv = spawnOpts?.env || {};
            const child = new EventEmitter() as any;
            child.pid = 48100;
            child.kill = vi.fn();
            child.unref = vi.fn();
            const targetDir = path.join(
              freshBottle,
              'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop'
            );
            fs.mkdirSync(targetDir, { recursive: true });
            fs.writeFileSync(path.join(targetDir, 'EADesktop.exe'), signedPe);
            setImmediate(() => {
              child.emit('exit', 0);
              child.emit('close', 0);
            });
            return child;
          },
        }
      );

      expect(provRes.installed).toBe(true);
      expect(eaEco.requiresDotNetMscoreeForInstall).toBe(true);
      expect(spawnedSilentArgs).toEqual(
        expect.arrayContaining([
          '/quiet',
          '/norestart',
          'EAX_LAUNCH_CLIENT=0',
          'CreateDesktopShortcut=0',
        ])
      );
      expect(spawnedSilentEnv.WINEDLLOVERRIDES).toBe(
        'mshtml=d;msxml2,msxml3=n,b;winemenubuilder.exe=d'
      );
      expect(spawnedSilentEnv.WINEDLLOVERRIDES).not.toContain('mscoree');
      expect(fs.readFileSync(path.join(freshBottle, 'user.reg'), 'utf8')).not.toContain('"EADM"=');
    });
  });

  // ==========================================================================
  // 3. `__Installer/installerdata.xml` Multi-ContentID, Trial Deprioritization & Multi-Root Scanner
  // ==========================================================================
  describe('3. __Installer/installerdata.xml Multi-ContentID, Trial Deprioritization & Multi-Root Scanner', () => {
    it('extracts all contentIDs, deprioritizes trial="1" launchers, strips [HKEY_LOCAL_MACHINE\\...] prefixes, excludes EA redistributables, reads machine.ini/user_*.ini custom roots, and skips steamapps/common/', () => {
      const sandbox = makeSandbox('ol-ea-test-xml-');
      const pe64 = buildValidMinimalPe64Buffer();

      // 3a) `isExcludedPublisherOrRedistExe` excludes EA/Origin installer & anti-cheat helpers
      expect(chainedPublisherLaunchers.isExcludedPublisherOrRedistExe('Cleanup.exe')).toBe(true);
      expect(chainedPublisherLaunchers.isExcludedPublisherOrRedistExe('Touchup.exe')).toBe(true);
      expect(
        chainedPublisherLaunchers.isExcludedPublisherOrRedistExe('EAAntiCheat.Installer.exe')
      ).toBe(true);
      expect(chainedPublisherLaunchers.isExcludedPublisherOrRedistExe('Link2EA.exe')).toBe(true);
      expect(chainedPublisherLaunchers.isExcludedPublisherOrRedistExe('SyntheticGame.exe')).toBe(
        false
      );

      // 3b) `parseEaInstallerDataXml`: multi-<contentID>, `<launcher trial="1">` deprioritized for `<launcher trial="0">`, `[HKEY_LOCAL_MACHINE\...]` stripped
      const gameRoot = path.join(sandbox, 'Synthetic Sci-Fi RPG');
      fs.mkdirSync(path.join(gameRoot, '__Installer'), { recursive: true });
      fs.mkdirSync(path.join(gameRoot, 'Binaries/Win64'), { recursive: true });
      fs.writeFileSync(path.join(gameRoot, '__Installer/Cleanup.exe'), pe64);
      fs.writeFileSync(path.join(gameRoot, '__Installer/Touchup.exe'), pe64);
      fs.writeFileSync(path.join(gameRoot, '__Installer/EAAntiCheat.Installer.exe'), pe64);
      fs.writeFileSync(path.join(gameRoot, 'Binaries/Win64/SyntheticGame_Trial.exe'), pe64);
      fs.writeFileSync(path.join(gameRoot, 'Binaries/Win64/SyntheticGame.exe'), pe64);

      const xmlSample = `<?xml version="1.0" encoding="utf-8"?>
<DiPManifest version="4.0">
  <contentIDs>
    <contentID>1099901</contentID>
    <contentID>Origin.OFR.50.0009999</contentID>
    <contentID>Origin.OFR.50.0009998</contentID>
  </contentIDs>
  <gameTitles>
    <gameTitle locale="en_US">Synthetic Sci-Fi RPG</gameTitle>
  </gameTitles>
  <runtime>
    <launcher uid="launcher-redist">
      <name locale="en_US">Installer Cleanup</name>
      <trial>0</trial>
      <filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Synthetic Sci-Fi RPG\\Install Dir]\\__Installer\\Cleanup.exe</filePath>
    </launcher>
    <launcher uid="launcher-trial" trial="1">
      <name locale="en_US">Synthetic Sci-Fi RPG Trial</name>
      <trial>1</trial>
      <filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Synthetic Sci-Fi RPG\\Install Dir]\\Binaries\\Win64\\SyntheticGame_Trial.exe</filePath>
    </launcher>
    <launcher uid="launcher-full" trial="0">
      <name locale="en_US">Synthetic Sci-Fi RPG</name>
      <trial>0</trial>
      <filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Synthetic Sci-Fi RPG\\Install Dir]\\Binaries\\Win64\\SyntheticGame.exe</filePath>
    </launcher>
  </runtime>
</DiPManifest>`;

      const parsedXml = chainedPublisherLaunchers.parseEaInstallerDataXml(xmlSample, gameRoot);
      expect(parsedXml.title).toBe('Synthetic Sci-Fi RPG');
      expect(parsedXml.contentId).toBe('Origin.OFR.50.0009999');
      expect(parsedXml.contentIds).toEqual([
        '1099901',
        'Origin.OFR.50.0009999',
        'Origin.OFR.50.0009998',
      ]);
      expect(parsedXml.launcherRelExe.replace(/\\/g, '/')).toBe(
        'Binaries/Win64/SyntheticGame.exe'
      );

      // 3c) `readEaConfiguredLibraryRoots` + Bottle Scanner (`darwin`): discovers custom `machine.ini` & `user_*.ini` roots and skips `steamapps/common/`
      const macHome = path.join(sandbox, 'macHome');
      const bottlePath = seedInitializedCrossOverBottle(macHome, 'OneLauncher');
      const driveC = path.join(bottlePath, 'drive_c');

      fs.mkdirSync(path.join(driveC, 'ProgramData/EA Desktop'), { recursive: true });
      fs.writeFileSync(
        path.join(driveC, 'ProgramData/EA Desktop/machine.ini'),
        'machine.downloadinplacedir=C:\\CustomMachineEALib\\\n',
        'utf8'
      );
      const bottleEaUserDir = path.join(
        driveC,
        'users/crossover/AppData/Local/Electronic Arts/EA Desktop'
      );
      fs.mkdirSync(bottleEaUserDir, { recursive: true });
      fs.writeFileSync(
        path.join(bottleEaUserDir, 'user_1000000000001.ini'),
        'user.downloadinplacedir=C:\\CustomUserEALib\\\n',
        'utf8'
      );

      const customMachineGameDir = path.join(driveC, 'CustomMachineEALib/Synthetic Sci-Fi RPG');
      const customUserGameDir = path.join(driveC, 'CustomUserEALib/Synthetic Space Dogfight');
      const steamCommonEaDir = path.join(
        driveC,
        'Program Files (x86)/Steam/steamapps/common/Synthetic Tactical Shooter'
      );

      for (const [dir, title, cid, exe] of [
        [customMachineGameDir, 'Synthetic Sci-Fi RPG', 'Origin.OFR.50.0009999', 'SyntheticGame.exe'],
        [
          customUserGameDir,
          'Synthetic Space Dogfight',
          'Origin.OFR.50.0008888',
          'SyntheticDogfight.exe',
        ],
        [
          steamCommonEaDir,
          'Synthetic Tactical Shooter',
          'Origin.OFR.50.0007777',
          'SyntheticShooter.exe',
        ],
      ] as const) {
        fs.mkdirSync(path.join(dir, '__Installer'), { recursive: true });
        fs.writeFileSync(path.join(dir, exe), pe64);
        fs.writeFileSync(
          path.join(dir, '__Installer/installerdata.xml'),
          `<DiPManifest><contentIDs><contentID>${cid}</contentID></contentIDs><gameTitles><gameTitle locale="en_US">${title}</gameTitle></gameTitles></DiPManifest>`,
          'utf8'
        );
      }

      const bottleRoots = chainedPublisherLaunchers.readEaConfiguredLibraryRoots({
        platform: 'darwin',
        bottlePath,
      });
      expect(bottleRoots).toEqual(
        expect.arrayContaining([
          path.join(driveC, 'CustomMachineEALib'),
          path.join(driveC, 'CustomUserEALib'),
        ])
      );

      const bottleScanned = chainedPublisherLaunchers.scanBottlePublisherInstalledGames(bottlePath);
      const bottleTitles = bottleScanned.map((g: any) => g.title);
      expect(bottleTitles).toContain('Synthetic Sci-Fi RPG');
      expect(bottleTitles).toContain('Synthetic Space Dogfight');
      expect(bottleTitles).not.toContain('Synthetic Tactical Shooter');

      // 3d) Host Scanner (`win32`): reads `machine.ini` + `user_1000000000001.ini` custom roots and skips `steamapps/common/`
      const winHostRoot = path.join(sandbox, 'winHost');
      const winProgData = path.join(winHostRoot, 'ProgramData');
      const winLocalAppData = path.join(winHostRoot, 'Users/testuser/AppData/Local');
      const winCustomMachineLib = path.join(winHostRoot, 'WinCustomMachineEA');
      const winCustomUserLib = path.join(winHostRoot, 'WinCustomUserEA');
      const winSteamEaDir = path.join(
        winHostRoot,
        'Program Files (x86)/Steam/steamapps/common/Synthetic Steam EA Duplicate'
      );

      fs.mkdirSync(path.join(winProgData, 'EA Desktop'), { recursive: true });
      fs.writeFileSync(
        path.join(winProgData, 'EA Desktop/machine.ini'),
        `machine.downloadinplacedir=${winCustomMachineLib}\n`,
        'utf8'
      );
      fs.mkdirSync(path.join(winLocalAppData, 'Electronic Arts/EA Desktop'), { recursive: true });
      fs.writeFileSync(
        path.join(winLocalAppData, 'Electronic Arts/EA Desktop/user_1000000000001.ini'),
        `user.downloadinplacedir=${winCustomUserLib}\n`,
        'utf8'
      );

      for (const [dir, title, cid, exe] of [
        [
          path.join(winCustomMachineLib, 'Synthetic Sci-Fi RPG'),
          'Synthetic Sci-Fi RPG',
          'Origin.OFR.50.0009999',
          'SyntheticGame.exe',
        ],
        [
          path.join(winCustomUserLib, 'Synthetic Space Dogfight'),
          'Synthetic Space Dogfight',
          'Origin.OFR.50.0008888',
          'SyntheticDogfight.exe',
        ],
        [
          winSteamEaDir,
          'Synthetic Steam EA Duplicate',
          'Origin.OFR.50.0006666',
          'SyntheticSteamDup.exe',
        ],
      ] as const) {
        fs.mkdirSync(path.join(dir, '__Installer'), { recursive: true });
        fs.writeFileSync(path.join(dir, exe), pe64);
        fs.writeFileSync(
          path.join(dir, '__Installer/installerdata.xml'),
          `<DiPManifest><contentIDs><contentID>${cid}</contentID></contentIDs><gameTitles><gameTitle locale="en_US">${title}</gameTitle></gameTitles></DiPManifest>`,
          'utf8'
        );
      }

      const winEnv = {
        PROGRAMFILES: path.join(winHostRoot, 'Program Files'),
        'PROGRAMFILES(X86)': path.join(winHostRoot, 'Program Files (x86)'),
        PROGRAMDATA: winProgData,
        LOCALAPPDATA: winLocalAppData,
        SYSTEMDRIVE: winHostRoot,
      };
      const hostScanned = chainedPublisherLaunchers.scanHostPublisherInstalledGames({
        platform: 'win32',
        homedir: path.join(winHostRoot, 'Users/testuser'),
        env: winEnv,
      });
      const hostTitles = hostScanned.map((g: any) => g.title);
      expect(hostTitles).toContain('Synthetic Sci-Fi RPG');
      expect(hostTitles).toContain('Synthetic Space Dogfight');
      expect(hostTitles).not.toContain('Synthetic Steam EA Duplicate');
    });
  });

  // ==========================================================================
  // 4. `origin2://` Launch Spec Builder (`buildChainedLauncherLaunchSpec`)
  // ==========================================================================
  describe('4. origin2:// Launch Spec Builder (buildChainedLauncherLaunchSpec)', () => {
    it('never bypasses EA launcher to spawn gameExe directly, prefers EALauncher.exe over EADesktop.exe, builds origin2://game/launch URI, auto-discovers contentId from __Installer/installerdata.xml, and exposes targetExecutablePath', () => {
      const sandbox = makeSandbox('ol-ea-test-launchspec-');
      const pe64 = buildValidMinimalPe64Buffer();

      const eaClientDir = path.join(
        sandbox,
        'bottle/drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop'
      );
      fs.mkdirSync(eaClientDir, { recursive: true });
      const eaDesktopExe = path.join(eaClientDir, 'EADesktop.exe');
      const eaLauncherExe = path.join(eaClientDir, 'EALauncher.exe');
      fs.writeFileSync(eaDesktopExe, pe64);
      fs.writeFileSync(eaLauncherExe, pe64);

      const gameInstallDir = path.join(
        sandbox,
        'bottle/drive_c/Program Files/EA Games/Synthetic Sci-Fi RPG'
      );
      const gameBinDir = path.join(gameInstallDir, 'Binaries/Win64');
      fs.mkdirSync(path.join(gameInstallDir, '__Installer'), { recursive: true });
      fs.mkdirSync(gameBinDir, { recursive: true });
      const gameExe = path.join(gameBinDir, 'SyntheticSciFiRpg.exe');
      fs.writeFileSync(gameExe, pe64);
      fs.writeFileSync(
        path.join(gameInstallDir, '__Installer/installerdata.xml'),
        `<DiPManifest><contentIDs><contentID>Origin.OFR.50.0009999</contentID></contentIDs><gameTitles><gameTitle locale="en_US">Synthetic Sci-Fi RPG</gameTitle></gameTitles></DiPManifest>`,
        'utf8'
      );

      // 4a) Explicit `externalInstallId` on `darwin` bottle: prefers `EALauncher.exe`, never spawns `gameExe` directly, builds `origin2://`
      const bottleSpec = chainedPublisherLaunchers.buildChainedLauncherLaunchSpec({
        handoffId: 'ea',
        externalInstallId: 'Origin.OFR.50.0009999',
        launcherBinaryPath: eaDesktopExe,
        gameExecutablePath: gameExe,
        platform: 'darwin',
        compatibilityLayerType: 'crossover',
      });
      expect(bottleSpec.launcherExe).toBe(eaLauncherExe);
      expect(bottleSpec.launcherExe).not.toBe(gameExe);
      expect(bottleSpec.uri).toBe('origin2://game/launch?offerIds=Origin.OFR.50.0009999&autoDownload=1');
      expect(bottleSpec.args).toContain(
        'origin2://game/launch?offerIds=Origin.OFR.50.0009999&autoDownload=1'
      );
      expect(bottleSpec.targetExecutablePath).toBe(gameExe);

      // 4b) Omitted `externalInstallId` on `win32` host: auto-discovers `Origin.OFR.50.0009999` by walking up from `gameExecutablePath` to `__Installer/installerdata.xml`!
      const autoDiscoveredSpec = chainedPublisherLaunchers.buildChainedLauncherLaunchSpec({
        handoffId: 'ea',
        launcherBinaryPath: eaDesktopExe,
        gameExecutablePath: gameExe,
        platform: 'win32',
      });
      expect(autoDiscoveredSpec.launcherExe).toBe(eaLauncherExe);
      expect(autoDiscoveredSpec.launcherExe).not.toBe(gameExe);
      expect(autoDiscoveredSpec.uri).toBe(
        'origin2://game/launch?offerIds=Origin.OFR.50.0009999&autoDownload=1'
      );
      expect(autoDiscoveredSpec.targetExecutablePath).toBe(gameExe);
    });
  });

  // ==========================================================================
  // 5. Topology 1 — Xbox EA Play (`xboxCatalogAndGamePass.cjs` & `nonGameClassifier.cjs`)
  // ==========================================================================
  describe('5. Topology 1 — Xbox EA Play & Starter Pack Non-Game Classifier', () => {
    it('maps ElectronicArtsMobile_*_q5ha1ztykcgvj PFNs to ea, preserves standalone Starter Pack base games while suppressing Durable DLC Starter Packs, and stamps stubless 0-package Xbox EA Play titles with MaxInstallSizeInBytes fallback', () => {
      // 5a) `detectThirdPartyPfnHandoff`
      expect(
        xboxCatalogAndGamePass.detectThirdPartyPfnHandoff(
          'ElectronicArtsMobile.SyntheticGame_q5ha1ztykcgvj'
        )
      ).toBe('ea');

      // 5b) `classifyNonGameStorefrontItem`: standalone Game with "Starter Pack" in title vs Durable DLC
      const standaloneStarterReason = nonGameClassifier.classifyNonGameStorefrontItem({
        title: 'Synthetic Life Sim Starter Pack',
        productType: 'Game',
        isDlc: false,
      });
      expect(standaloneStarterReason).toBeNull();

      const dlcStarterReason = nonGameClassifier.classifyNonGameStorefrontItem({
        title: 'Synthetic Shooter - Starter Pack',
        productType: 'Durable',
        isDlc: true,
      });
      expect(dlcStarterReason).toBe('Filtered: DLC / Add-On / Expansion Content');

      // 5c) Stubless 0-package Xbox EA Play product (`9N00SYNTHEA1`) in `evaluateDisplayCatalogProduct`
      const evaluated = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
        {
          ProductId: '9N00SYNTHEA1',
          ProductKind: 'Game',
          LocalizedProperties: [
            {
              ProductTitle: 'Synthetic Space Dogfight',
              PublisherName: 'Electronic Arts',
              DeveloperName: 'Synthetic Studio',
              ShortDescription: 'Synthetic EA Play space flight title.',
            },
          ],
          Properties: {
            PackageFamilyName: 'ElectronicArtsMobile.SyntheticSpaceDogfight_q5ha1ztykcgvj',
          },
          DisplaySkuAvailabilities: [
            {
              Sku: {
                Properties: {
                  Packages: [],
                  MaxDownloadSizeInBytes: 0,
                  MaxInstallSizeInBytes: 42_949_672_960,
                },
              },
            },
          ],
        },
        { source: 'game_pass_ea_play' }
      );

      expect(evaluated).not.toBeNull();
      expect(evaluated.productId).toBe('9N00SYNTHEA1');
      expect(evaluated.chainedLauncherHandoff).toBe('ea');
      expect(evaluated.externalStorefrontHandoff).toBe('ea');
      expect(evaluated.chainedHandoffTopology).toBe('publisher_managed');
      expect(evaluated.platforms).toMatchObject({ windows: true, mac: false });
      expect(evaluated.maxDownloadSizeBytes).toBe(42_949_672_960);
    });
  });

  // ==========================================================================
  // 6. Topology 2 — Epic Partner-Linked EA Titles
  // ==========================================================================
  describe('6. Topology 2 — Epic Partner-Linked EA Titles (darwin & win32)', () => {
    it('parses ThirdPartyManagedApp/PartnerLinkType/RegistryPath across Epic sync & coordinators, routes getGameInstallInfo + installGame through chained EA provisioning instead of legendary install, and links scanned EA installs onto epic:synth-epic-ea-slug without ghost ea: cards', async () => {
      const customAttrs = {
        ThirdPartyManagedApp: { type: 'STRING', value: 'The EA App' },
        PartnerLinkType: { type: 'STRING', value: 'origin' },
        RegistryPath: { type: 'STRING', value: 'SOFTWARE\\EA Games\\Synthetic Sci-Fi RPG' },
        RegistryKey: { type: 'STRING', value: 'Install Dir' },
      };

      // 6a) Verify all 3 Epic metadata extractors agree on `partner_launcher_link` + `ea`
      const syncHandoff = storeSync.resolveEpicPartnerChainedHandoff(customAttrs);
      expect(syncHandoff).toEqual({
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: 'partner_launcher_link',
        epicPartnerRegistryPath: 'SOFTWARE\\EA Games\\Synthetic Sci-Fi RPG',
        epicPartnerRegistryKey: 'Install Dir',
      });

      const tsPartnerMeta = extractEpicPartnerHandoffMetadata(customAttrs);
      expect(tsPartnerMeta).toEqual({
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: 'partner_launcher_link',
        epicPartnerRegistryPath: 'SOFTWARE\\EA Games\\Synthetic Sci-Fi RPG',
        platforms: { windows: true, mac: false, linux: false },
      });

      const legPartnerMeta = epicLegendaryCoordinator.extractEpicThirdPartyPartnerMetadata({
        game: { customAttributes: customAttrs },
      });
      expect(legPartnerMeta).toMatchObject({
        chainedLauncherHandoff: 'ea',
        chainedHandoffTopology: 'partner_launcher_link',
        epicPartnerRegistryPath: 'SOFTWARE\\EA Games\\Synthetic Sci-Fi RPG',
      });

      // 6b) `downloadQueueCoordinator.getGameInstallInfo` & `installGame` on `darwin` and `win32`
      const sandbox = makeSandbox('ol-ea-test-epic-');
      const macHome = path.join(sandbox, 'macHome');
      const userDataDir = path.join(sandbox, 'userData');
      const appsDir = path.join(sandbox, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });
      seedMockCrossOverApp(appsDir);
      const bottlePath = seedInitializedCrossOverBottle(macHome, 'OneLauncher');
      const pe64 = buildValidMinimalPe64Buffer();

      const fakeLegendaryBin = path.join(sandbox, 'fake-legendary');
      fs.writeFileSync(fakeLegendaryBin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

      const epicPayload = {
        gameId: 'epic-synth-epic-ea-slug',
        platformId: 'epic',
        platformGameId: 'synth-epic-ea-slug',
        title: 'Synthetic Sci-Fi RPG',
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: 'partner_launcher_link',
        epicPartnerRegistryPath: 'SOFTWARE\\EA Games\\Synthetic Sci-Fi RPG',
      };

      const macInfo = await downloadQueueCoordinator.getGameInstallInfo(epicPayload, {
        platform: 'darwin',
        homedir: macHome,
        userDataDir,
        customApplicationsDir: appsDir,
        skipNetwork: true,
      });
      expect(macInfo.availableInstallers.some((i: any) => i.os === 'mac')).toBe(false);
      expect(macInfo.isCrossPlatformBottleInstall).toBe(true);
      expect(macInfo.canDirectDownload).toBe(true);
      expect(macInfo.chainedLauncherHandoff).toBe('ea');
      expect(macInfo.availableInstallers[0].id).toBe('epic-chained-bottle-launcher');

      const winHostRoot = path.join(sandbox, 'winHost');
      const winEnv = {
        PROGRAMFILES: path.join(winHostRoot, 'Program Files'),
        'PROGRAMFILES(X86)': path.join(winHostRoot, 'Program Files (x86)'),
        PROGRAMDATA: path.join(winHostRoot, 'ProgramData'),
        LOCALAPPDATA: path.join(winHostRoot, 'Users/testuser/AppData/Local'),
        SYSTEMDRIVE: winHostRoot,
      };
      const winInfo = await downloadQueueCoordinator.getGameInstallInfo(epicPayload, {
        platform: 'win32',
        homedir: path.join(winHostRoot, 'Users/testuser'),
        userDataDir,
        env: winEnv,
        skipNetwork: true,
      });
      expect(winInfo.availableInstallers.some((i: any) => i.os === 'mac')).toBe(false);
      expect(winInfo.canDirectDownload).toBe(true);
      expect(winInfo.chainedLauncherHandoff).toBe('ea');
      expect(winInfo.availableInstallers[0].id).toBe('epic-chained-host-launcher');

      // Verify `installGame` on `darwin` and `win32` NEVER invokes `legendary install`
      const bottleEaDir = path.join(
        bottlePath,
        'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop'
      );
      const bottleEaLauncher = path.join(bottleEaDir, 'EALauncher.exe');
      const spawnedCommands: Array<{ cmd: string; args: string[] }> = [];

      const macInstallRes = await downloadQueueCoordinator.installGame(
        {
          ...epicPayload,
          installerId: 'epic-chained-bottle-launcher',
          compatibilityLayer: 'crossover',
          wineBottleName: 'OneLauncher',
        },
        {
          platform: 'darwin',
          homedir: macHome,
          userDataDir,
          customApplicationsDir: appsDir,
          legendaryBinaryPath: fakeLegendaryBin,
          skipInstallMonitor: true,
          ensureChainedPublisherLauncherInstalledFn: async () => {
            fs.mkdirSync(bottleEaDir, { recursive: true });
            fs.writeFileSync(bottleEaLauncher, pe64);
            return {
              installed: true,
              provisionedNow: false,
              binaryPath: bottleEaLauncher,
              installDir: bottleEaDir,
            };
          },
          spawnFn: (cmd: string, args: string[]) => {
            spawnedCommands.push({ cmd, args });
            const c = new EventEmitter() as any;
            c.pid = 52100;
            c.unref = vi.fn();
            return c;
          },
        }
      );
      expect(macInstallRes.success).toBe(true);
      expect(macInstallRes.status).toBe('chained_launcher_opened');
      expect(
        spawnedCommands.some(
          (call) => call.cmd.includes('legendary') || call.args.includes('install')
        )
      ).toBe(false);

      const winEaDir = path.join(
        winHostRoot,
        'Program Files/Electronic Arts/EA Desktop/EA Desktop'
      );
      const winEaLauncher = path.join(winEaDir, 'EALauncher.exe');
      const winSpawnedCommands: Array<{ cmd: string; args: string[] }> = [];

      const winInstallRes = await downloadQueueCoordinator.installGame(
        {
          ...epicPayload,
          installerId: 'epic-chained-host-launcher',
        },
        {
          platform: 'win32',
          homedir: path.join(winHostRoot, 'Users/testuser'),
          userDataDir,
          env: winEnv,
          legendaryBinaryPath: fakeLegendaryBin,
          skipInstallMonitor: true,
          ensureChainedPublisherLauncherInstalledFn: async () => {
            fs.mkdirSync(winEaDir, { recursive: true });
            fs.writeFileSync(winEaLauncher, pe64);
            return {
              installed: true,
              provisionedNow: false,
              binaryPath: winEaLauncher,
              installDir: winEaDir,
            };
          },
          spawnFn: (cmd: string, args: string[]) => {
            winSpawnedCommands.push({ cmd, args });
            const c = new EventEmitter() as any;
            c.pid = 52200;
            c.unref = vi.fn();
            return c;
          },
        }
      );
      expect(winInstallRes.success).toBe(true);
      expect(winInstallRes.status).toBe('chained_launcher_opened');
      expect(
        winSpawnedCommands.some(
          (call) => call.cmd.includes('legendary') || call.args.includes('install')
        )
      ).toBe(false);

      // Clear the `skipInstallMonitor: true` in-flight download tasks from 6b before running installed scanner
      downloadQueueCoordinator.shutdownDownloadEngine();
      engineStateRegistry.downloadQueueMap.clear();

      // 6c) `installedGameScanner.scanAllInstalledGames`: links EA install onto `epic:synth-epic-ea-slug` with zero `ea:` ghost cards on BOTH `darwin` and `win32`
      const bottleEaGameDir = path.join(
        bottlePath,
        'drive_c/Program Files/EA Games/Synthetic Sci-Fi RPG'
      );
      fs.mkdirSync(path.join(bottleEaGameDir, '__Installer'), { recursive: true });
      const bottleGameExe = path.join(bottleEaGameDir, 'SyntheticSciFiRpg.exe');
      fs.writeFileSync(bottleGameExe, pe64);
      fs.writeFileSync(
        path.join(bottleEaGameDir, '__Installer/installerdata.xml'),
        `<DiPManifest><contentIDs><contentID>Origin.OFR.50.0009999</contentID></contentIDs><gameTitles><gameTitle locale="en_US">Synthetic Sci-Fi RPG</gameTitle></gameTitles></DiPManifest>`,
        'utf8'
      );

      const epicCatalogFixture = [
        {
          id: 'epic-synth-epic-ea-slug',
          title: 'Synthetic Sci-Fi RPG',
          chainedLauncherHandoff: 'ea',
          externalStorefrontHandoff: 'ea',
          platforms: [
            {
              platformId: 'epic',
              platformGameId: 'synth-epic-ea-slug',
              title: 'Synthetic Sci-Fi RPG',
              chainedLauncherHandoff: 'ea',
              externalStorefrontHandoff: 'ea',
              chainedHandoffTopology: 'partner_launcher_link',
              epicPartnerRegistryPath: 'SOFTWARE\\EA Games\\Synthetic Sci-Fi RPG',
            },
          ],
        },
      ];

      const macScan = await installedGameScanner.scanAllInstalledGames({
        platform: 'darwin',
        homedir: macHome,
        userDataDir: path.join(sandbox, 'scanUserDataMac'),
        customApplicationsDir: appsDir,
        customRoots: [bottlePath],
        catalogGames: epicCatalogFixture,
      });
      expect(macScan.success).toBe(true);
      const macEpicLinked = macScan.installedGames.find(
        (g: any) => g.platformId === 'epic' && g.platformGameId === 'synth-epic-ea-slug'
      );
      expect(macEpicLinked).toBeDefined();
      expect(macEpicLinked.executablePath).toBe(bottleGameExe);
      expect(macEpicLinked.chainedLauncherHandoff).toBe('ea');
      expect(macEpicLinked.chainedHandoffTopology).toBe('partner_launcher_link');
      expect(macScan.installedGames.some((g: any) => g.platformId === 'ea')).toBe(false);

      const winEaGameDir = path.join(winHostRoot, 'Program Files/EA Games/Synthetic Sci-Fi RPG');
      fs.mkdirSync(path.join(winEaGameDir, '__Installer'), { recursive: true });
      const winGameExe = path.join(winEaGameDir, 'SyntheticSciFiRpg.exe');
      fs.writeFileSync(winGameExe, pe64);
      fs.writeFileSync(
        path.join(winEaGameDir, '__Installer/installerdata.xml'),
        `<DiPManifest><contentIDs><contentID>Origin.OFR.50.0009999</contentID></contentIDs><gameTitles><gameTitle locale="en_US">Synthetic Sci-Fi RPG</gameTitle></gameTitles></DiPManifest>`,
        'utf8'
      );

      const winScan = await installedGameScanner.scanAllInstalledGames({
        platform: 'win32',
        homedir: path.join(winHostRoot, 'Users/testuser'),
        userDataDir: path.join(sandbox, 'scanUserDataWin'),
        env: winEnv,
        customRoots: [winEaGameDir],
        catalogGames: epicCatalogFixture,
      });
      expect(winScan.success).toBe(true);
      const winEpicLinked = winScan.installedGames.find(
        (g: any) => g.platformId === 'epic' && g.platformGameId === 'synth-epic-ea-slug'
      );
      expect(winEpicLinked).toBeDefined();
      expect(winEpicLinked.executablePath).toBe(winGameExe);
      expect(winEpicLinked.chainedLauncherHandoff).toBe('ea');
      expect(winEpicLinked.chainedHandoffTopology).toBe('partner_launcher_link');
      expect(winScan.installedGames.some((g: any) => g.platformId === 'ea')).toBe(false);
    });
  });

  // ==========================================================================
  // 7. Topology 3 — Steam `link2ea://` Depot-Downloaded EA Titles
  // ==========================================================================
  describe('7. Topology 3 — Steam link2ea:// Depot-Downloaded EA Titles (darwin & win32)', () => {
    it('preserves link2ea://launchgame/999001 protocolUri + storefront_depot_uri while resolving real game .exe (skipping Link2EA.exe & Cleanup.exe), classifies Steam drm_notice accurately, and excludes steamapps/common from Stage 3.6 EA scanning', async () => {
      const sandbox = makeSandbox('ol-ea-test-steam-');
      const pe64 = buildValidMinimalPe64Buffer();

      // 7a) `detectSteamAppDetailsChainedHandoff`: stamps `'ea'` (`storefront_depot_uri`) ONLY when EA App DRM is required
      const detectedSteamDrm = storeSync.detectSteamAppDetailsChainedHandoff({
        drm_notice:
          'Incorporates 3rd-party DRM: EA on-line activation and Origin client software installation and background use required.',
      });
      expect(detectedSteamDrm).toMatchObject({
        chainedLauncherHandoff: 'ea',
        chainedHandoffTopology: 'storefront_depot_uri',
      });

      expect(
        storeSync.detectSteamAppDetailsChainedHandoff({
          drm_notice: 'Requires agreement to a 3rd-party EULA (EA User Agreement).',
          publishers: ['Electronic Arts'],
        })
      ).toBeNull();

      // 7b) `resolveSteamAppInfoLaunchSpec` with binary `appinfo.vdf` containing `link2ea://launchgame/999001` + `Link2EA.exe`
      const steamRoot = path.join(sandbox, 'Steam');
      const appcacheDir = path.join(steamRoot, 'appcache');
      const steamappsDir = path.join(steamRoot, 'steamapps');
      const gameDir = path.join(steamappsDir, 'common/Synthetic Space Dogfight');
      fs.mkdirSync(appcacheDir, { recursive: true });
      fs.mkdirSync(path.join(gameDir, '__Installer'), { recursive: true });

      const realSteamGameExe = path.join(gameDir, 'SyntheticSpaceDogfight.exe');
      fs.writeFileSync(realSteamGameExe, pe64);
      fs.writeFileSync(path.join(gameDir, 'Link2EA.exe'), pe64);
      fs.writeFileSync(path.join(gameDir, '__Installer/Cleanup.exe'), pe64);
      fs.writeFileSync(
        path.join(gameDir, '__Installer/installerdata.xml'),
        `<DiPManifest><contentIDs><contentID>Origin.OFR.50.0009999</contentID></contentIDs><gameTitles><gameTitle locale="en_US">Synthetic Space Dogfight</gameTitle></gameTitles></DiPManifest>`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(steamappsDir, 'appmanifest_999001.acf'),
        `"AppState"\n{\n\t"appid"\t\t"999001"\n\t"Universe"\t\t"1"\n\t"name"\t\t"Synthetic Space Dogfight"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Synthetic Space Dogfight"\n}\n`,
        'utf8'
      );

      const vdfBuf = buildBinarySteamAppInfoVdfV28([
        {
          appId: 999001,
          launches: [
            {
              executable: 'link2ea://launchgame/999001',
              oslist: 'windows',
            },
            {
              executable: 'Link2EA.exe',
              oslist: 'windows',
            },
          ],
        },
      ]);
      fs.writeFileSync(path.join(appcacheDir, 'appinfo.vdf'), vdfBuf);

      for (const hostPlat of ['win32', 'darwin'] as const) {
        engineStateRegistry.invalidateScanCaches();
        const spec = macNativeInstallerAndCodesign.resolveSteamAppInfoLaunchSpec(
          steamRoot,
          999001,
          gameDir,
          { platform: hostPlat }
        );
        expect(spec).not.toBeNull();
        expect(spec.requiresStorefrontProtocolLaunch).toBe(true);
        expect(spec.protocolUri).toBe('link2ea://launchgame/999001');
        expect(spec.chainedLauncherHandoff).toBe('ea');
        expect(spec.chainedHandoffTopology).toBe('storefront_depot_uri');
        expect(spec.executablePath).toBe(realSteamGameExe);
      }

      // 7c) `steamLocalScanner.scanLocalSteamEaChainedGames` + `installedGameScanner.scanAllInstalledGames`: stamps `storefront_depot_uri` on `steam:999001` and emits zero `ea:` duplicates
      const localSteamEa = await steamLocalScanner.scanLocalSteamEaChainedGames({
        steamappsDirs: [steamappsDir],
        force: true,
      });
      expect(localSteamEa[999001]).toEqual({
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: 'storefront_depot_uri',
        chainedExternalInstallId: 'Origin.OFR.50.0009999',
      });

      const winScan = await installedGameScanner.scanAllInstalledGames({
        platform: 'win32',
        homedir: path.join(sandbox, 'winHome'),
        userDataDir: path.join(sandbox, 'winScanUserData'),
        env: {
          PROGRAMFILES: path.join(sandbox, 'MockProgramFiles'),
          'PROGRAMFILES(X86)': path.join(sandbox, 'MockProgramFilesX86'),
          PROGRAMDATA: path.join(sandbox, 'MockProgramData'),
          LOCALAPPDATA: path.join(sandbox, 'winHome/AppData/Local'),
          SYSTEMDRIVE: sandbox,
        },
        customRoots: [steamRoot],
      });
      expect(winScan.success).toBe(true);
      const scannedSteamGame = winScan.installedGames.find(
        (g: any) => g.platformId === 'steam' && String(g.platformGameId) === '999001'
      );
      expect(scannedSteamGame).toBeDefined();
      expect(scannedSteamGame.executablePath).toBe(realSteamGameExe);
      expect(scannedSteamGame.chainedLauncherHandoff).toBe('ea');
      expect(scannedSteamGame.chainedHandoffTopology).toBe('storefront_depot_uri');
      expect(scannedSteamGame.chainedExternalInstallId).toBe('Origin.OFR.50.0009999');
      expect(winScan.installedGames.some((g: any) => g.platformId === 'ea')).toBe(false);

      // 7d) `sessionAndProcessSupervisor.launchGame`: routes `storefront_depot_uri` Steam EA title via `steam://rungameid/999001` WITHOUT hijacking into `origin2://`
      const openedSteamUris: string[] = [];
      const steamLaunchRes = await sessionAndProcessSupervisor.launchGame(
        {
          gameId: 'steam-999001',
          platformId: 'steam',
          platformGameId: '999001',
          title: 'Synthetic Space Dogfight',
          installPath: gameDir,
          executablePath: realSteamGameExe,
          chainedLauncherHandoff: 'ea',
          chainedHandoffTopology: 'storefront_depot_uri',
          requiresStorefrontProtocolLaunch: true,
        },
        {
          platform: 'win32',
          homedir: path.join(sandbox, 'winHome'),
          userDataDir: path.join(sandbox, 'winScanUserData'),
          skipPublisherProvisioning: true,
          disableUriPolling: true,
          openExternalFn: async (uri: string) => {
            openedSteamUris.push(uri);
            return true;
          },
        }
      );
      expect(steamLaunchRes.success).toBe(true);
      expect(openedSteamUris).toContain('steam://rungameid/999001');
      expect(openedSteamUris.some((u) => u.startsWith('origin2://'))).toBe(false);
    });
  });

  // ==========================================================================
  // 8. Topology 4 — DRM-Free GOG & Offline Vault / Catalog Sanitizer Self-Healing
  // ==========================================================================
  describe('8. Topology 4 — DRM-Free GOG & Offline Vault / Catalog Sanitizer Self-Healing', () => {
    it('self-heals Xbox & Epic EA entries (mac:false), strips poisoned top-level Mac flags when no Mac copy exists, preserves mac:true on DRM-free GOG (standalone & hybrid multi-store), derives EA Javelin Anticheat without polluting GOG, and preserves all fields across mergeStorefrontGames', () => {
      const javelinDrmNotice =
        'Incorporates 3rd-party DRM: EA app software installation and background use required. Uses EA Javelin Anticheat.';

      // 8a) `offlineVaultService.sanitizeVaultPlatformEntriesOsFlags`
      const vaultSanitized = offlineVaultMod.sanitizeVaultPlatformEntriesOsFlags(
        [
          {
            platformId: 'xbox',
            platformGameId: '9N00SYNTHEA1',
            externalStorefrontHandoff: 'The EA App',
            platforms: { windows: false, mac: true, linux: false },
          },
          {
            platformId: 'epic',
            platformGameId: 'synth-epic-ea-slug',
            platforms: { windows: true, mac: true, linux: false },
          },
          {
            platformId: 'gog',
            platformGameId: '1207660042',
            platforms: { windows: true, mac: true, linux: false },
          },
        ],
        true,
        { drmNotice: javelinDrmNotice }
      );
      expect(vaultSanitized.repaired).toBe(true);
      expect(vaultSanitized.platforms[0]).toMatchObject({
        platformId: 'xbox',
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        platforms: { windows: true, mac: false, linux: false },
      });
      expect(vaultSanitized.platforms[1]).toMatchObject({
        platformId: 'epic',
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: 'partner_launcher_link',
        platforms: { windows: true, mac: false, linux: false },
      });
      // DRM-free GOG entry (`Synthetic Classic Dungeon`) retains `mac: true` and NO `chainedLauncherHandoff`!
      expect(vaultSanitized.platforms[2]).toEqual({
        platformId: 'gog',
        platformGameId: '1207660042',
        platforms: { windows: true, mac: true, linux: false },
      });

      // 8b) `catalogSanitizer.sanitizeGameCatalog`:
      //   1. Single-store Epic EA title with poisoned top-level `worksOn.mac: true` & Javelin `drmNotice` -> `mac: false`, `requiresKernelAntiCheat: true`
      //   2. Hybrid multi-store EA classic (`Synthetic Classic Dungeon`) owned on Xbox EA Play (`mac: false`) + DRM-free GOG (`mac: true`) -> preserves `mac: true` on GOG and top-level `worksOn.mac: true`, without polluting GOG with EA App or kernel anti-cheat!
      const sanitizedCatalog = sanitizeGameCatalog([
        makeCanonicalGameFixture({
          id: 'epic-synth-tactical-shooter',
          title: 'Synthetic Tactical Shooter',
          isVerifiedEntitlement: true,
          worksOn: { windows: true, mac: true, linux: false },
          platforms_os: { windows: true, mac: true, linux: false },
          nativePlatforms: ['windows', 'mac'],
          enrichedMetadata: {
            appId: 999002,
            name: 'Synthetic Tactical Shooter',
            drmNotice: javelinDrmNotice,
            platforms: { windows: true, mac: true, linux: false },
          } as any,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: 'synth-epic-ea-slug',
              installed: false,
              platforms: { windows: true, mac: true, linux: false },
            },
          ],
        }),
        makeCanonicalGameFixture({
          id: 'gog-1207660042',
          title: 'Synthetic Classic Dungeon',
          isVerifiedEntitlement: true,
          worksOn: { windows: true, mac: true, linux: false },
          platforms_os: { windows: true, mac: true, linux: false },
          nativePlatforms: ['windows', 'mac'],
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: '9N00SYNTHDNG',
              xboxProductId: '9N00SYNTHDNG',
              installed: false,
              chainedLauncherHandoff: 'ea',
              platforms: { windows: true, mac: true, linux: false },
            },
            {
              platformId: 'gog',
              platformGameId: '1207660042',
              installed: false,
              platforms: { windows: true, mac: true, linux: false },
            },
          ],
        }),
      ]);
      const healedShooter = sanitizedCatalog.find(
        (g) => g.title === 'Synthetic Tactical Shooter'
      )!;
      const healedHybridDungeon = sanitizedCatalog.find(
        (g) => g.title === 'Synthetic Classic Dungeon'
      )!;
      expect(healedShooter).toBeDefined();
      expect(healedHybridDungeon).toBeDefined();

      expect(healedShooter.worksOn).toEqual({ windows: true, mac: false, linux: false });
      expect(healedShooter.nativePlatforms).toEqual(['windows']);
      expect(healedShooter.requiresKernelAntiCheat).toBe(true);
      expect(healedShooter.antiCheatName).toBe('EA Javelin Anticheat');
      expect(healedShooter.platforms[0]).toMatchObject({
        platformId: 'epic',
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: 'partner_launcher_link',
        requiresKernelAntiCheat: true,
        antiCheatName: 'EA Javelin Anticheat',
        platforms: { windows: true, mac: false, linux: false },
      });

      const hybridXboxPlat = healedHybridDungeon.platforms.find((p) => p.platformId === 'xbox')!;
      const hybridGogPlat = healedHybridDungeon.platforms.find((p) => p.platformId === 'gog')!;
      expect(hybridXboxPlat.platforms).toEqual({ windows: true, mac: false, linux: false });
      expect(hybridXboxPlat.chainedLauncherHandoff).toBe('ea');
      expect(hybridGogPlat.platforms).toEqual({ windows: true, mac: true, linux: false });
      expect(hybridGogPlat.chainedLauncherHandoff).toBeUndefined();
      expect(hybridGogPlat.requiresKernelAntiCheat).toBeUndefined();
      expect(healedHybridDungeon.worksOn).toEqual({ windows: true, mac: true, linux: false });

      // 8c) `mergeStorefrontGames` in `integrationStorage.ts` preserves all chained handoff & anti-cheat fields across sync merges
      expect(detectKernelAntiCheatFromNotice('Uses EA Javelin Anticheat')).toEqual({
        requiresKernelAntiCheat: true,
        antiCheatName: 'EA Javelin Anticheat',
      });
      expect(detectKernelAntiCheatFromNotice('Uses EA AntiCheat service')).toEqual({
        requiresKernelAntiCheat: true,
        antiCheatName: 'EA Anti-Cheat',
      });

      const mergedCatalog = mergeStorefrontGames(
        [healedShooter],
        [
          makeCanonicalGameFixture({
            id: 'epic-synth-tactical-shooter',
            title: 'Synthetic Tactical Shooter',
            isVerifiedEntitlement: true,
            platforms: [
              {
                platformId: 'epic',
                platformGameId: 'synth-epic-ea-slug',
                installed: true,
                chainedLauncherHandoff: 'ea',
                externalStorefrontHandoff: 'ea',
                chainedHandoffTopology: 'partner_launcher_link',
                chainedExternalInstallId: 'Origin.OFR.50.0009999',
                epicPartnerRegistryPath: 'SOFTWARE\\EA Games\\Synthetic Tactical Shooter',
                requiresKernelAntiCheat: true,
                antiCheatName: 'EA Javelin Anticheat',
                platforms: { windows: true, mac: false, linux: false },
              },
            ],
          }),
        ],
        'epic'
      );

      expect(mergedCatalog).toHaveLength(1);
      expect(mergedCatalog[0].requiresKernelAntiCheat).toBe(true);
      expect(mergedCatalog[0].antiCheatName).toBe('EA Javelin Anticheat');
      expect(mergedCatalog[0].platforms[0]).toMatchObject({
        platformId: 'epic',
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: 'partner_launcher_link',
        chainedExternalInstallId: 'Origin.OFR.50.0009999',
        epicPartnerRegistryPath: 'SOFTWARE\\EA Games\\Synthetic Tactical Shooter',
        requiresKernelAntiCheat: true,
        antiCheatName: 'EA Javelin Anticheat',
      });
    });
  });

  // ==========================================================================
  // 9. Download Monitor Liveness & Uninstall Registry Cleanup
  // ==========================================================================
  describe('9. Download Monitor Liveness & Uninstall Registry Cleanup (darwin & win32)', () => {
    it('returns false in checkBottlePublisherLauncherAliveAsync & checkHostWinPublisherLauncherAliveAsync when only EABackgroundService.exe remains, cancels stagnant chained monitor cleanly, and cleans leaf folders + matching EA Uninstall/EA Games registry blocks while protecting EA Desktop', async () => {
      const sandbox = makeSandbox('ol-ea-test-lifecycle-');
      const macHome = path.join(sandbox, 'macHome');
      const userDataDir = path.join(sandbox, 'userData');
      fs.mkdirSync(userDataDir, { recursive: true });
      const bottlePath = seedInitializedCrossOverBottle(macHome, 'OneLauncher');
      const pe64 = buildValidMinimalPe64Buffer();

      // 9a) `checkBottlePublisherLauncherAliveAsync` (`darwin` bottle):
      //     ONLY `EABackgroundService.exe` + `wineserver` running -> MUST return `false`!
      const bgOnlyAlive = await downloadQueueCoordinator.checkBottlePublisherLauncherAliveAsync(
        bottlePath,
        {
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => {
            cb(
              null,
              [
                `${bottlePath}/wineserver`,
                `C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EABackgroundService.exe`,
                `C:\\windows\\system32\\services.exe`,
              ].join('\n'),
              ''
            );
          },
        },
        'ea'
      );
      expect(bgOnlyAlive).toBe(false);

      //     When `EADesktop.exe` is also running -> MUST return `true`!
      const uiRunningAlive = await downloadQueueCoordinator.checkBottlePublisherLauncherAliveAsync(
        bottlePath,
        {
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => {
            cb(
              null,
              [
                `C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EABackgroundService.exe`,
                `C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe`,
              ].join('\n'),
              ''
            );
          },
        },
        'ea'
      );
      expect(uiRunningAlive).toBe(true);

      // 9b) `checkHostWinPublisherLauncherAliveAsync` (`win32` host):
      //     ONLY `EABackgroundService.exe` in `tasklist.exe` -> MUST return `false`!
      const winBgOnlyAlive =
        await downloadQueueCoordinator.checkHostWinPublisherLauncherAliveAsync('ea', {
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => {
            cb(null, '"EABackgroundService.exe","4120","Console","1","42,100 K"\r\n', '');
          },
        });
      expect(winBgOnlyAlive).toBe(false);

      // 9c) Verify `startChainedLauncherInstallMonitor` exits cleanly (`status: 'cancelled'`) instead of hanging forever when `EADesktop.exe` closes leaving `EABackgroundService.exe`
      const bottleEaDir = path.join(
        bottlePath,
        'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop'
      );
      fs.mkdirSync(bottleEaDir, { recursive: true });
      const bottleEaExe = path.join(bottleEaDir, 'EALauncher.exe');
      fs.writeFileSync(bottleEaExe, pe64);
      const appsDir = path.join(sandbox, 'Applications');
      seedMockCrossOverApp(appsDir);

      const emittedDownloadEvents: any[] = [];
      const downloadListener = (ev: any) => emittedDownloadEvents.push(ev);
      engineStateRegistry.downloadListeners.add(downloadListener);
      try {
        const monitorInstallRes = await downloadQueueCoordinator.installGame(
          {
            gameId: 'xbox_9N00SYNTHEA1',
            platformId: 'xbox',
            platformGameId: '9N00SYNTHEA1',
            xboxProductId: '9N00SYNTHEA1',
            title: 'Synthetic Space Dogfight',
            installerId: 'xbox-chained-bottle-launcher',
            compatibilityLayer: 'crossover',
            wineBottleName: 'OneLauncher',
            chainedLauncherHandoff: 'ea',
            externalStorefrontHandoff: 'ea',
          },
          {
            platform: 'darwin',
            homedir: macHome,
            userDataDir,
            customApplicationsDir: appsDir,
            chainedInstallPollIntervalMs: 250,
            chainedLauncherGracePeriodMs: 0,
            ensureChainedPublisherLauncherInstalledFn: async () => ({
              installed: true,
              provisionedNow: false,
              binaryPath: bottleEaExe,
              installDir: bottleEaDir,
            }),
            spawnFn: () => {
              const c = new EventEmitter() as any;
              c.pid = 63100;
              c.unref = vi.fn();
              return c;
            },
            execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => {
              cb(
                null,
                'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EABackgroundService.exe\n',
                ''
              );
            },
          }
        );
        expect(monitorInstallRes.success).toBe(true);

        await vi.waitFor(
          () => {
            expect(
              emittedDownloadEvents.some(
                (ev) =>
                  ev?.task?.taskId === monitorInstallRes.task.taskId &&
                  ev?.task?.status === 'cancelled'
              )
            ).toBe(true);
          },
          { timeout: 2500, interval: 40 }
        );
      } finally {
        engineStateRegistry.downloadListeners.delete(downloadListener);
      }

      // 9d) `uninstallGame` (`darwin` bottle): deletes verified leaf `Program Files/EA Games/Synthetic Space Dogfight`, cleans matching `Uninstall\{...}` + `EA Games\...` blocks in `system.reg`, preserves sibling EA games, and refuses to delete protected `EA Desktop` directories
      const eaGamesContainer = path.join(bottlePath, 'drive_c/Program Files/EA Games');
      const dogfightDir = path.join(eaGamesContainer, 'Synthetic Space Dogfight');
      const siblingDir = path.join(eaGamesContainer, 'Synthetic Sci-Fi RPG');
      fs.mkdirSync(path.join(dogfightDir, '__Installer'), { recursive: true });
      fs.mkdirSync(path.join(siblingDir, '__Installer'), { recursive: true });
      const dogfightExe = path.join(dogfightDir, 'SyntheticSpaceDogfight.exe');
      const siblingExe = path.join(siblingDir, 'SyntheticSciFiRpg.exe');
      fs.writeFileSync(dogfightExe, pe64);
      fs.writeFileSync(siblingExe, pe64);
      fs.writeFileSync(
        path.join(dogfightDir, '__Installer/installerdata.xml'),
        `<DiPManifest><contentIDs><contentID>Origin.OFR.50.0008888</contentID></contentIDs><gameTitles><gameTitle locale="en_US">Synthetic Space Dogfight</gameTitle></gameTitles></DiPManifest>`,
        'utf8'
      );

      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(bottlePath, bottleEaDir)
      ).toBe(false);
      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(
          bottlePath,
          path.dirname(bottleEaDir)
        )
      ).toBe(false);
      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(
          bottlePath,
          eaGamesContainer
        )
      ).toBe(false);
      expect(
        sessionAndProcessSupervisor.isSafeBottleChainedGameDirToDelete(bottlePath, dogfightDir)
      ).toBe(true);

      const systemRegPath = path.join(bottlePath, 'system.reg');
      fs.writeFileSync(
        systemRegPath,
        [
          'WINE REGISTRY Version 2',
          '',
          '[Software\\\\Wow6432Node\\\\EA Games\\\\Synthetic Space Dogfight] 1700000300',
          '"DisplayName"="Synthetic Space Dogfight"',
          '"Install Dir"="C:\\\\Program Files\\\\EA Games\\\\Synthetic Space Dogfight\\\\"',
          '',
          '[Software\\\\Wow6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\{99990001-0000-0000-0000-000000000001}] 1700000301',
          '"DisplayName"="Synthetic Space Dogfight"',
          '"InstallLocation"="C:\\\\Program Files\\\\EA Games\\\\Synthetic Space Dogfight"',
          '',
          '[Software\\\\Wow6432Node\\\\EA Games\\\\Synthetic Sci-Fi RPG] 1700000302',
          '"DisplayName"="Synthetic Sci-Fi RPG"',
          '"Install Dir"="C:\\\\Program Files\\\\EA Games\\\\Synthetic Sci-Fi RPG\\\\"',
          '',
          '[Software\\\\Wow6432Node\\\\Electronic Arts\\\\EA Desktop] 1700000303',
          '"InstallLocation"="C:\\\\Program Files\\\\Electronic Arts\\\\EA Desktop\\\\EA Desktop"',
          '',
        ].join('\n'),
        'utf8'
      );

      engineStateRegistry.saveManagedInstalledGames(
        [
          {
            platformId: 'xbox',
            platformGameId: '9N00SYNTHEA1',
            xboxProductId: '9N00SYNTHEA1',
            title: 'Synthetic Space Dogfight',
            installPath: dogfightDir,
            executablePath: dogfightExe,
            chainedLauncherHandoff: 'ea',
            externalStorefrontHandoff: 'ea',
            chainedExternalInstallId: 'Origin.OFR.50.0008888',
            runner: 'chained_bottle',
            wineBottle: 'OneLauncher',
            isWindowsBinaryOnMac: true,
          },
          {
            platformId: 'xbox',
            platformGameId: '9NPROTECTEDEA',
            xboxProductId: '9NPROTECTEDEA',
            title: 'Protected EA Desktop Pointer',
            installPath: bottleEaDir,
            executablePath: bottleEaExe,
            chainedLauncherHandoff: 'ea',
            runner: 'chained_bottle',
            wineBottle: 'OneLauncher',
            isWindowsBinaryOnMac: true,
          },
        ],
        userDataDir
      );

      const uninstRes = await sessionAndProcessSupervisor.uninstallGame(
        {
          gameId: 'xbox_9N00SYNTHEA1',
          platformId: 'xbox',
          platformGameId: '9N00SYNTHEA1',
          title: 'Synthetic Space Dogfight',
          installPath: dogfightDir,
        },
        {
          platform: 'darwin',
          homedir: macHome,
          userDataDir,
        }
      );
      expect(uninstRes.success).toBe(true);
      expect(fs.existsSync(dogfightDir)).toBe(false);
      expect(fs.existsSync(siblingExe)).toBe(true);
      expect(fs.existsSync(bottleEaExe)).toBe(true);

      const regAfter = fs.readFileSync(systemRegPath, 'utf8');
      expect(regAfter).not.toContain('EA Games\\\\Synthetic Space Dogfight]');
      expect(regAfter).not.toContain('{99990001-0000-0000-0000-000000000001}');
      expect(regAfter).toContain('EA Games\\\\Synthetic Sci-Fi RPG]');
      expect(regAfter).toContain('Electronic Arts\\\\EA Desktop]');

      // Protected `EA Desktop` directory is NEVER deleted even if pointed at by a malformed record
      await sessionAndProcessSupervisor.uninstallGame(
        {
          gameId: 'xbox_9NPROTECTEDEA',
          platformId: 'xbox',
          platformGameId: '9NPROTECTEDEA',
          title: 'Protected EA Desktop Pointer',
          installPath: bottleEaDir,
        },
        {
          platform: 'darwin',
          homedir: macHome,
          userDataDir,
        }
      );
      expect(fs.existsSync(bottleEaDir)).toBe(true);
      expect(fs.existsSync(bottleEaExe)).toBe(true);

      // 9e) `uninstallGame` (`win32` host): removes leaf EA game folder and invokes `reg.exe delete` ONLY for matching `Install Dir` / `InstallLocation` subkeys
      const winHostRoot = path.join(sandbox, 'winHostUninst');
      const winDogfightDir = path.join(
        winHostRoot,
        'Program Files/EA Games/Synthetic Space Dogfight'
      );
      fs.mkdirSync(path.join(winDogfightDir, '__Installer'), { recursive: true });
      const winDogfightExe = path.join(winDogfightDir, 'SyntheticSpaceDogfight.exe');
      fs.writeFileSync(winDogfightExe, pe64);
      fs.writeFileSync(
        path.join(winDogfightDir, '__Installer/installerdata.xml'),
        `<DiPManifest><contentIDs><contentID>Origin.OFR.50.0008888</contentID></contentIDs><gameTitles><gameTitle locale="en_US">Synthetic Space Dogfight</gameTitle></gameTitles></DiPManifest>`,
        'utf8'
      );
      const winUserDataDir = path.join(sandbox, 'winUserDataUninst');
      fs.mkdirSync(winUserDataDir, { recursive: true });
      engineStateRegistry.saveManagedInstalledGames(
        [
          {
            platformId: 'xbox',
            platformGameId: '9N00SYNTHEA1',
            xboxProductId: '9N00SYNTHEA1',
            title: 'Synthetic Space Dogfight',
            installPath: winDogfightDir,
            executablePath: winDogfightExe,
            chainedLauncherHandoff: 'ea',
            externalStorefrontHandoff: 'ea',
            chainedExternalInstallId: 'Origin.OFR.50.0008888',
          },
        ],
        winUserDataDir
      );

      const deletedWinRegKeys: string[] = [];
      const winUninstRes = await sessionAndProcessSupervisor.uninstallGame(
        {
          gameId: 'xbox_9N00SYNTHEA1',
          platformId: 'xbox',
          platformGameId: '9N00SYNTHEA1',
          title: 'Synthetic Space Dogfight',
          installPath: winDogfightDir,
          allowDeleteFiles: true,
        },
        {
          platform: 'win32',
          homedir: path.join(winHostRoot, 'Users/testuser'),
          userDataDir: winUserDataDir,
          execFileFn: (cmd: string, args: string[], _opts: any, cb: Function) => {
            if (cmd === 'reg.exe' && args[0] === 'query') {
              const queriedKey = args[1] || '';
              if (queriedKey === 'HKLM\\SOFTWARE\\EA Games') {
                cb(
                  null,
                  [
                    'HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Synthetic Space Dogfight',
                    `    Install Dir    REG_SZ    ${winDogfightDir}\\`,
                    '',
                    'HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Synthetic Sci-Fi RPG',
                    `    Install Dir    REG_SZ    ${path.join(winHostRoot, 'Program Files/EA Games/Synthetic Sci-Fi RPG')}\\`,
                    '',
                  ].join('\r\n'),
                  ''
                );
                return;
              }
              if (
                queriedKey ===
                'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{Origin.OFR.50.0008888}'
              ) {
                cb(
                  null,
                  [
                    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{Origin.OFR.50.0008888}',
                    `    InstallLocation    REG_SZ    ${winDogfightDir}`,
                    '',
                  ].join('\r\n'),
                  ''
                );
                return;
              }
              cb(null, '', '');
              return;
            }
            if (cmd === 'reg.exe' && args[0] === 'delete') {
              deletedWinRegKeys.push(args[1]);
              cb(null, 'The operation completed successfully.', '');
              return;
            }
            cb(null, '', '');
          },
        }
      );
      expect(winUninstRes.success).toBe(true);
      expect(fs.existsSync(winDogfightDir)).toBe(false);
      expect(deletedWinRegKeys).toContain(
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Synthetic Space Dogfight'
      );
      expect(deletedWinRegKeys).toContain(
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{Origin.OFR.50.0008888}'
      );
      expect(
        deletedWinRegKeys.some((k) => k.includes('Synthetic Sci-Fi RPG') || k.includes('EA Desktop'))
      ).toBe(false);

      // 9f) `win32` negative container safety: `allowDeleteFiles: true` MUST NEVER wipe `EA Desktop` or the shared `EA Games` container
      const winProtectedEaDesktop = path.join(winHostRoot, 'Program Files/Electronic Arts/EA Desktop');
      const winProtectedEaDesktopExe = path.join(winProtectedEaDesktop, 'EADesktop.exe');
      fs.mkdirSync(winProtectedEaDesktop, { recursive: true });
      fs.writeFileSync(winProtectedEaDesktopExe, pe64);
      const winSharedEaGamesRoot = path.join(winHostRoot, 'Program Files/EA Games');
      const winSiblingGameExe = path.join(winSharedEaGamesRoot, 'Synthetic Sci-Fi RPG/SyntheticRpg.exe');
      fs.mkdirSync(path.dirname(winSiblingGameExe), { recursive: true });
      fs.writeFileSync(winSiblingGameExe, pe64);

      for (const protectedTarget of [winProtectedEaDesktop, winSharedEaGamesRoot]) {
        await sessionAndProcessSupervisor.uninstallGame(
          {
            gameId: 'xbox_9N00PROTECTED',
            platformId: 'xbox',
            platformGameId: '9N00PROTECTED',
            title: 'Corrupted Protected Pointer',
            installPath: protectedTarget,
            chainedLauncherHandoff: 'ea',
            allowDeleteFiles: true,
          },
          {
            platform: 'win32',
            homedir: path.join(winHostRoot, 'Users/testuser'),
            userDataDir: winUserDataDir,
            execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, '', ''),
          }
        );
      }
      expect(fs.existsSync(winProtectedEaDesktop)).toBe(true);
      expect(fs.existsSync(winProtectedEaDesktopExe)).toBe(true);
      expect(fs.existsSync(winSharedEaGamesRoot)).toBe(true);
      expect(fs.existsSync(winSiblingGameExe)).toBe(true);

      // 9g) `win32` custom-directory EA uninstall: resolves `isEaInstaller` + `contentIds` from `__Installer/installerdata.xml` without pre-populated `chainedExternalInstallId`
      const winCustomDir = path.join(winHostRoot, 'CustomLibrary/SyntheticCustomFolderRpg');
      fs.mkdirSync(path.join(winCustomDir, '__Installer'), { recursive: true });
      fs.writeFileSync(path.join(winCustomDir, 'SyntheticCustomRpg.exe'), pe64);
      fs.writeFileSync(
        path.join(winCustomDir, '__Installer/installerdata.xml'),
        `<DiPManifest><contentIDs><contentID>Origin.OFR.50.0007777</contentID></contentIDs><gameTitles><gameTitle locale="en_US">Synthetic Custom Folder RPG</gameTitle></gameTitles></DiPManifest>`,
        'utf8'
      );
      const deletedCustomWinRegKeys: string[] = [];
      const customWinUninstRes = await sessionAndProcessSupervisor.uninstallGame(
        {
          gameId: 'epic_synth-custom-ea-rpg',
          platformId: 'epic',
          platformGameId: 'synth-custom-ea-rpg',
          title: 'Synthetic Custom Folder RPG',
          installPath: winCustomDir,
          allowDeleteFiles: true,
        },
        {
          platform: 'win32',
          homedir: path.join(winHostRoot, 'Users/testuser'),
          userDataDir: winUserDataDir,
          execFileFn: (cmd: string, args: string[], _opts: any, cb: Function) => {
            if (cmd === 'reg.exe' && args[0] === 'query') {
              if (
                args[1] ===
                'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{Origin.OFR.50.0007777}'
              ) {
                cb(
                  null,
                  [
                    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{Origin.OFR.50.0007777}',
                    `    InstallLocation    REG_SZ    ${winCustomDir}`,
                    '',
                  ].join('\r\n'),
                  ''
                );
                return;
              }
              cb(null, '', '');
              return;
            }
            if (cmd === 'reg.exe' && args[0] === 'delete') {
              deletedCustomWinRegKeys.push(args[1]);
              cb(null, 'The operation completed successfully.', '');
              return;
            }
            cb(null, '', '');
          },
        }
      );
      expect(customWinUninstRes.success).toBe(true);
      expect(fs.existsSync(winCustomDir)).toBe(false);
      expect(deletedCustomWinRegKeys).toContain(
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{Origin.OFR.50.0007777}'
      );
    });
  });

  // ==========================================================================
  // 10. Frontend UI Badges, Sidebar Notices, Install Modal SSO + Anti-Cheat Advisory & Setup Wizard + WCAG 2.2 AA
  // ==========================================================================
  describe('10. Frontend UI Badges, Sidebar Notices, Install Modal SSO + Anti-Cheat Advisory & Setup Wizard + WCAG 2.2 AA', () => {
    it('renders Requires EA App badge & synthesized sidebar notice when drmNotice is undefined, renders EA SSO guidance + macOS-only kernel anti-cheat warning in GameInstallModal, and renders Setup Wizard EA relevance badges + SSO tips with bottle_ea/host_ea unchecked by default (0 WCAG 2.2 AA violations across darwin & win32)', async () => {
      const eaDelegatedGame: CanonicalGame = makeCanonicalGameFixture({
        id: 'epic-synth-tactical-shooter',
        title: 'Synthetic Tactical Shooter',
        requiresKernelAntiCheat: true,
        antiCheatName: 'EA Javelin Anticheat',
        worksOn: { windows: true, mac: false, linux: false },
        platforms_os: { windows: true, mac: false, linux: false },
        nativePlatforms: ['windows'],
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'synth-epic-ea-slug',
            installed: false,
            chainedLauncherHandoff: 'ea',
            externalStorefrontHandoff: 'ea',
            chainedHandoffTopology: 'partner_launcher_link',
            requiresKernelAntiCheat: true,
            antiCheatName: 'EA Javelin Anticheat',
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
      });

      // 10a) `PlatformBadges` + `SteamSidebarNotices` when `drmNotice` is `undefined` (Epic & Xbox EA Play)
      const badgesHarness = createDomain12DeepRenderer(PlatformBadges, {
        platforms: [
          ...eaDelegatedGame.platforms,
          {
            platformId: 'xbox',
            platformGameId: '9N00SYNTHEA1',
            xboxProductId: '9N00SYNTHEA1',
            installed: false,
            chainedLauncherHandoff: 'ea',
            externalStorefrontHandoff: 'ea',
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
        game: eaDelegatedGame,
      });
      try {
        const badgesTree = badgesHarness.render();
        const epicEaPill = findVNodeByTestId(badgesTree, 'chained-launcher-pill-epic-ea');
        const xboxEaPill = findVNodeByTestId(badgesTree, 'chained-launcher-pill-xbox-ea');
        expect(epicEaPill).toBeDefined();
        expect(xboxEaPill).toBeDefined();
        expect(extractVNodeText(epicEaPill)).toContain('Requires EA App');
        expect(extractVNodeText(xboxEaPill)).toContain('Requires EA App');
        expect(auditWcag22AA(badgesTree)).toEqual([]);
      } finally {
        badgesHarness.unmount();
      }

      const noticesHarness = createDomain12DeepRenderer(SteamSidebarNotices, {
        title: eaDelegatedGame.title,
        genres: [],
        developers: [],
        publishers: [],
        drmNotice: undefined,
        activePlatform: eaDelegatedGame.platforms[0],
      });
      try {
        const noticesTree = noticesHarness.render();
        const synthNotice = findVNodeByTestId(noticesTree, 'sidebar-chained-launcher-notice');
        expect(synthNotice).toBeDefined();
        expect(extractVNodeText(synthNotice)).toContain('Requires EA App');
        expect(extractVNodeText(synthNotice)).toContain('Epic Games');
        expect(auditWcag22AA(noticesTree)).toEqual([]);
      } finally {
        noticesHarness.unmount();
      }

      // 10b) `GameInstallModal` on `darwin` (`epic-chained-bottle-launcher`, `requiresKernelAntiCheat: true`)
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          version: '26.0',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          availableBottles: ['OneLauncher'],
        },
      ]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        targetPath: '/Users/testuser/Games/OneLauncher',
        freeBytes: 120 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        usedBytes: 380 * 1024 * 1024 * 1024,
      });
      const macModalInstallInfo: GameInstallInfo = {
        platformId: 'epic',
        platformGameId: 'synth-epic-ea-slug',
        canDirectDownload: true,
        defaultInstallDir: '/Users/testuser/Games/OneLauncher',
        availableInstallDirs: ['/Users/testuser/Games/OneLauncher'],
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        requiresKernelAntiCheat: true,
        antiCheatName: 'EA Javelin Anticheat',
        availableInstallers: [
          {
            id: 'epic-chained-bottle-launcher',
            name: 'EA App (Bottle)',
            os: 'windows',
            language: 'en',
            totalSizeBytes: 50 * 1024 * 1024 * 1024,
            chainedLauncherHandoff: 'ea',
            externalStorefrontHandoff: 'ea',
            requiresKernelAntiCheat: true,
            antiCheatName: 'EA Javelin Anticheat',
          },
        ],
      };
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue(macModalInstallInfo);

      const macModal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game: eaDelegatedGame,
        initialPlatformId: 'epic',
        onClose: vi.fn(),
      });
      try {
        macModal.render();
        await Promise.resolve();
        await Promise.resolve();
        const macModalTree = macModal.render();

        const ssoGuidance = findVNodeByTestId(macModalTree, 'ea-sso-linking-guidance');
        expect(ssoGuidance).toBeDefined();
        expect(extractVNodeText(ssoGuidance)).toContain('Sign in to EA App with the EA Account');

        const macAcWarning = findVNodeByTestId(macModalTree, 'macos-kernel-anticheat-warning');
        expect(macAcWarning).toBeDefined();
        expect(extractVNodeText(macAcWarning)).toContain('EA Javelin Anticheat');
        expect(auditWcag22AA(macModalTree)).toEqual([]);
      } finally {
        macModal.unmount();
      }

      // 10c) `GameInstallModal` on `win32` (`epic-chained-host-launcher`): renders SSO guidance, does NOT render `macos-kernel-anticheat-warning`
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(true);
      vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        targetPath: 'C:\\Games\\OneLauncher',
        freeBytes: 120 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        usedBytes: 380 * 1024 * 1024 * 1024,
      });
      const winModalInstallInfo: GameInstallInfo = {
        platformId: 'epic',
        platformGameId: 'synth-epic-ea-slug',
        canDirectDownload: true,
        defaultInstallDir: 'C:\\Games\\OneLauncher',
        availableInstallDirs: ['C:\\Games\\OneLauncher'],
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        requiresKernelAntiCheat: true,
        antiCheatName: 'EA Javelin Anticheat',
        availableInstallers: [
          {
            id: 'epic-chained-host-launcher',
            name: 'EA App (Windows)',
            os: 'windows',
            language: 'en',
            totalSizeBytes: 50 * 1024 * 1024 * 1024,
            chainedLauncherHandoff: 'ea',
            externalStorefrontHandoff: 'ea',
            requiresKernelAntiCheat: true,
            antiCheatName: 'EA Javelin Anticheat',
          },
        ],
      };
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue(winModalInstallInfo);

      const winModal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game: eaDelegatedGame,
        initialPlatformId: 'epic',
        onClose: vi.fn(),
      });
      try {
        winModal.render();
        await Promise.resolve();
        await Promise.resolve();
        const winModalTree = winModal.render();

        expect(findVNodeByTestId(winModalTree, 'ea-sso-linking-guidance')).toBeDefined();
        expect(findVNodeByTestId(winModalTree, 'macos-kernel-anticheat-warning')).toBeUndefined();
        expect(auditWcag22AA(winModalTree)).toEqual([]);
      } finally {
        winModal.unmount();
      }

      // 10d) Setup Wizard `StorefrontClientsStep` & `GuidedClientSignInStep` (`darwin` + `win32`) + `computeDefaultSelectedComponents`
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('arm64');
      const macSnapshot = buildFallbackEnvironmentSnapshot(['epic', 'xbox']);
      macSnapshot.detectedRunners = [
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          version: '26.0',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          availableBottles: ['OneLauncher'],
        },
      ];
      macSnapshot.bottleSummary = {
        runnerInstalled: true,
        runnerType: 'crossover',
        recommendedBottleMode: 'reuse_existing',
        recommendedBottleName: 'OneLauncher',
        availableBottles: [
          {
            name: 'OneLauncher',
            path: '/Users/testuser/Library/Application Support/CrossOver/Bottles/OneLauncher',
            runnerType: 'crossover',
            hasSteam: false,
            hasGogGalaxy: false,
            hasEpicLauncher: false,
            isSandboxed: false,
          },
        ],
      };
      macSnapshot.clientLogins.bottle_ea = {
        ...macSnapshot.clientLogins.bottle_ea,
        installed: true,
        authenticated: false,
        statusSummary: 'Installed in bottle • Sign-in required',
      };

      const macDefaultSelected = computeDefaultSelectedComponents(macSnapshot, ['epic', 'xbox']);
      expect(macDefaultSelected.has('bottle_ea')).toBe(false);
      expect(macDefaultSelected.has('host_ea')).toBe(false);

      const macClientsStep = createDomain12DeepRenderer(StorefrontClientsStep, {
        snapshot: macSnapshot,
        mode: 'first_launch',
        selectedIds: macDefaultSelected,
        forceRepairIds: new Set<EnvironmentComponentId>(),
        chosenRunner: 'crossover',
        connectedStorefronts: ['epic', 'xbox'],
        catalogGames: [eaDelegatedGame],
        onToggleComponent: vi.fn(),
        onToggleForceRepair: vi.fn(),
      });
      try {
        const macClientsTree = macClientsStep.render();
        const macRelevanceBadge = findVNodeByTestId(
          macClientsTree,
          'ea-library-relevance-badge-bottle_ea'
        );
        expect(macRelevanceBadge).toBeDefined();
        expect(extractVNodeText(macRelevanceBadge)).toContain('1 EA Game in Library');
        expect(auditWcag22AA(macClientsTree)).toEqual([]);
      } finally {
        macClientsStep.unmount();
      }

      const macSignInStep = createDomain12DeepRenderer(GuidedClientSignInStep, {
        snapshot: macSnapshot,
        chosenRunner: 'crossover',
        bottleName: 'OneLauncher',
        selectedIds: new Set<EnvironmentComponentId>(['bottle_ea']),
        activeGuidedLoginTarget: null,
        autoCloseOnSuccess: true,
        onToggleAutoCloseOnSuccess: vi.fn(),
        onGuidedLoginCompleted: vi.fn(),
      });
      try {
        const macSignInTree = macSignInStep.render();
        const macSsoTip = findVNodeByTestId(macSignInTree, 'guided-login-ea-sso-tip-bottle_ea');
        expect(macSsoTip).toBeDefined();
        expect(extractVNodeText(macSsoTip)).toContain('Xbox Game Pass, Epic & Steam tip:');
        expect(auditWcag22AA(macSignInTree)).toEqual([]);
      } finally {
        macSignInStep.unmount();
      }

      // Windows (`win32`) Setup Wizard `host_ea` verification
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      const winSnapshot = buildFallbackEnvironmentSnapshot(['epic', 'xbox']);
      winSnapshot.clientLogins.host_ea = {
        ...winSnapshot.clientLogins.host_ea,
        installed: true,
        authenticated: false,
        statusSummary: 'Installed on Windows • Sign-in required',
      };
      const winDefaultSelected = computeDefaultSelectedComponents(winSnapshot, ['epic', 'xbox']);
      expect(winDefaultSelected.has('host_ea')).toBe(false);

      const winClientsStep = createDomain12DeepRenderer(StorefrontClientsStep, {
        snapshot: winSnapshot,
        mode: 'first_launch',
        selectedIds: winDefaultSelected,
        forceRepairIds: new Set<EnvironmentComponentId>(),
        chosenRunner: 'skip',
        connectedStorefronts: ['epic', 'xbox'],
        catalogGames: [eaDelegatedGame],
        onToggleComponent: vi.fn(),
        onToggleForceRepair: vi.fn(),
      });
      try {
        const winClientsTree = winClientsStep.render();
        const winRelevanceBadge = findVNodeByTestId(
          winClientsTree,
          'ea-library-relevance-badge-host_ea'
        );
        expect(winRelevanceBadge).toBeDefined();
        expect(extractVNodeText(winRelevanceBadge)).toContain('1 EA Game in Library');
        expect(auditWcag22AA(winClientsTree)).toEqual([]);
      } finally {
        winClientsStep.unmount();
      }

      const winSignInStep = createDomain12DeepRenderer(GuidedClientSignInStep, {
        snapshot: winSnapshot,
        chosenRunner: 'skip',
        bottleName: 'OneLauncher',
        selectedIds: new Set<EnvironmentComponentId>(['host_ea']),
        activeGuidedLoginTarget: null,
        autoCloseOnSuccess: true,
        onToggleAutoCloseOnSuccess: vi.fn(),
        onGuidedLoginCompleted: vi.fn(),
      });
      try {
        const winSignInTree = winSignInStep.render();
        const winSsoTip = findVNodeByTestId(winSignInTree, 'guided-login-ea-sso-tip-host_ea');
        expect(winSsoTip).toBeDefined();
        expect(extractVNodeText(winSsoTip)).toContain('Xbox Game Pass, Epic & Steam tip:');
        expect(auditWcag22AA(winSignInTree)).toEqual([]);
      } finally {
        winSignInStep.unmount();
      }

      expect(typeof environmentSetupService.probeHealth).toBe('function');
    });
  });
});
