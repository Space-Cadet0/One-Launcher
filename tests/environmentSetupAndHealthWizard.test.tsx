import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';

import type { CanonicalGame } from '../src/contracts/game';
import type {
  CompatibilityLayerInfo,
  CompatibilityRunnerDescriptor,
  GameInstallInfo,
  ResolvedLaunchModePreview,
} from '../src/contracts/launcher';
import type {
  ClientLoginTargetId,
  EnvironmentHealthSnapshot,
  EnvironmentSetupProgressEvent,
  GuidedClientLoginResult,
  RunEnvironmentSetupResult,
  SetupWizardPersistedState,
  SetupWizardStepId,
  StartGuidedClientLoginRequest,
} from '../src/contracts/environmentSetup';
import {
  OPEN_SYSTEM_SETUP_EVENT,
  WIZARD_STATE_STORAGE_KEY,
  EnvironmentSetupService,
  buildFallbackEnvironmentSnapshot,
  buildProvisioningTasksFromSelection,
  computeDefaultSelectedComponents,
  createDefaultSetupWizardState,
  environmentSetupService,
  getRemovedComponents,
  shouldAutoOpenSetupWizardOnStartup,
} from '../src/services/launcher/environmentSetupService';
import { launcherService } from '../src/services/launcher/launcherService';
import { SystemSetupWizardModal } from '../src/components/Launcher/SystemSetupWizard/SystemSetupWizardModal';
import { TopNavBar } from '../src/components/Navigation/TopNavBar';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';
import { CompatibilityLayerSection } from '../src/components/Launcher/LaunchConfig/CompatibilityLayerSection';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';

const nodeRequire = createRequire(import.meta.url);
const environmentHealthProber = nodeRequire('../electron/launcher/environmentHealthProber.cjs');
const environmentProvisioner = nodeRequire('../electron/launcher/environmentProvisioner.cjs');
const launcherIpcHandlers = nodeRequire('../electron/ipc/launcherIpcHandlers.cjs');
const launcherEngine = nodeRequire('../electron/launcherEngine.cjs');
const { DatabaseSync } = nodeRequire('node:sqlite');

// ============================================================================
// Synthetic PII-Safe Constants (Strictly compliant with piiHygieneGuard.ts)
// ============================================================================
const SYNTHETIC_STEAM_ID_PRIMARY = '76561198000000042';
const SYNTHETIC_STEAM_ID_MISMATCH = '76561198099999999';
const SYNTHETIC_GOG_USER_ID_PRIMARY = '1000000042';
const SYNTHETIC_GOG_USER_ID_MISMATCH = '1000000099';
const SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY = `${'0'.repeat(30)}42`;
const SYNTHETIC_EPIC_ACCOUNT_ID_MISMATCH = `${'0'.repeat(30)}99`;

// ============================================================================
// Hermetic Filesystem, Binary & VNode Inspection Helpers
// ============================================================================

function listFilesRecursively(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const results: string[] = [];
  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        results.push(`symlink:${relPath}`);
      } else if (entry.isDirectory()) {
        results.push(`dir:${relPath}`);
        walk(fullPath);
      } else {
        const st = fs.statSync(fullPath);
        results.push(`file:${relPath}:${st.size}`);
      }
    }
  };
  walk(rootDir);
  return results.sort();
}

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
    buf.writeUInt32LE(certTableSize, certFileOffset + 0); // dwLength
    buf.writeUInt16LE(0x0200, certFileOffset + 4); // wRevision = WIN_CERT_REVISION_2_0
    buf.writeUInt16LE(0x0002, certFileOffset + 6); // wCertificateType = WIN_CERT_TYPE_PKCS_SIGNED_DATA
    // Synthetic ASN.1 SEQUENCE header for PKCS#7 payload
    buf[certFileOffset + 8] = 0x30;
    buf[certFileOffset + 9] = 0x81;
    buf[certFileOffset + 10] = 0x75;
  }

  return buf;
}

function buildMockFetchResponse(opts: {
  status?: number;
  body: Buffer | string;
  headers?: Record<string, string>;
  url?: string;
}) {
  const status = opts.status ?? 200;
  const buf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
  const headerMap = new Map<string, string>();
  headerMap.set('content-length', String(buf.length));
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headerMap.set(k.toLowerCase(), v);
    }
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    url: opts.url ?? '',
    headers: {
      get: (name: string) => headerMap.get(String(name).toLowerCase()) ?? null,
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
  const wineBin = path.join(binDir, 'wine');
  const cxbottleBin = path.join(binDir, 'cxbottle');
  fs.writeFileSync(wineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(cxbottleBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const infoPlist = path.join(appPath, 'Contents/Info.plist');
  fs.writeFileSync(
    infoPlist,
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

function seedInitializedCrossOverBottle(
  homedir: string,
  bottleName: string,
  opts: {
    withSteam?: boolean;
    withGogGalaxy?: boolean;
    withEpicLauncher?: boolean;
    sandboxed?: boolean;
  } = {}
): string {
  const bottlePath = path.join(
    homedir,
    'Library/Application Support/CrossOver/Bottles',
    bottleName
  );
  const sys32Dir = path.join(bottlePath, 'drive_c/windows/system32');
  const userDir = path.join(bottlePath, 'drive_c/users/crossover');
  fs.mkdirSync(sys32Dir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(bottlePath, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
  fs.writeFileSync(path.join(bottlePath, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');

  if (opts.sandboxed !== false) {
    fs.mkdirSync(path.join(userDir, 'Documents'), { recursive: true });
  } else {
    const hostDocs = path.join(homedir, 'Documents');
    fs.mkdirSync(hostDocs, { recursive: true });
    fs.symlinkSync(hostDocs, path.join(userDir, 'Documents'));
  }

  if (opts.withSteam) {
    const steamDir = path.join(bottlePath, 'drive_c/Program Files (x86)/Steam');
    fs.mkdirSync(steamDir, { recursive: true });
    fs.writeFileSync(path.join(steamDir, 'steam.exe'), 'MZ-SYNTHETIC-STEAM', 'utf8');
  }
  if (opts.withGogGalaxy) {
    const gogDir = path.join(bottlePath, 'drive_c/Program Files (x86)/GOG Galaxy');
    fs.mkdirSync(gogDir, { recursive: true });
    fs.writeFileSync(path.join(gogDir, 'GalaxyClient.exe'), 'MZ-SYNTHETIC-GOG', 'utf8');
  }
  if (opts.withEpicLauncher) {
    const epicDir = path.join(
      bottlePath,
      'drive_c/Program Files (x86)/Epic Games/Launcher/Portal/Binaries/Win64'
    );
    fs.mkdirSync(epicDir, { recursive: true });
    fs.writeFileSync(path.join(epicDir, 'EpicGamesLauncher.exe'), 'MZ-SYNTHETIC-EPIC', 'utf8');
  }

  return bottlePath;
}

function buildSteamLoginUsersVdf(users: Array<{
  steamId64: string;
  accountName: string;
  personaName: string;
  mostRecent: boolean;
  allowAutoLogin: boolean;
  timestamp?: number;
}>): string {
  const blocks = users
    .map(
      (u) => `\t"${u.steamId64}"
\t{
\t\t"AccountName"\t\t"${u.accountName}"
\t\t"PersonaName"\t\t"${u.personaName}"
\t\t"RememberPassword"\t\t"${u.allowAutoLogin ? '1' : '0'}"
\t\t"MostRecent"\t\t"${u.mostRecent ? '1' : '0'}"
\t\t"AllowAutoLogin"\t\t"${u.allowAutoLogin ? '1' : '0'}"
\t\t"Timestamp"\t\t"${u.timestamp ?? 1700000100}"
\t}`
    )
    .join('\n');
  return `"users"\n{\n${blocks}\n}\n`;
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

/**
 * Deterministic WCAG 2.2 AA accessibility auditor over rendered VNode trees & static HTML markup.
 * Enforces `axe-core` WCAG 2.2 AA equivalents in a pure Node/Vitest environment:
 *  - `dialog-name`: `<dialog>` has valid `aria-labelledby` pointing to an existing heading or `aria-label`
 *  - `duplicate-id` / `duplicate-id-aria`: zero duplicate `id` attributes
 *  - `aria-valid-attr-value`: all `aria-labelledby`, `aria-describedby`, and `htmlFor` IDs resolve
 *  - `button-name` & `button-type`: every `<button>` has explicit `type` and non-empty accessible name
 *  - `label`: every `<input>`, `<select>`, and `<textarea>` has an associated `<label htmlFor>` or `aria-label`/`aria-labelledby`
 *  - `progressbar-name`: every `<progress>` has an accessible name and valid `max`/indeterminate `value` semantics
 *  - `target-size` (WCAG 2.2 SC 2.5.8 AA): interactive buttons meet >=24x24px sizing classes (`min-h-6` / padded hit boxes)
 *  - `color-contrast` guard: forbids low-contrast muted text classes (`text-slate-500/600/700`) on dark modal surfaces
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

  // Verify XML/HTML structural well-formedness via DOMParser on static markup
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

    // Check broken ID references on aria-labelledby / aria-describedby / htmlFor
    for (const refAttr of ['aria-labelledby', 'aria-describedby'] as const) {
      if (typeof props[refAttr] === 'string' && props[refAttr].trim()) {
        const refIds = props[refAttr].trim().split(/\s+/);
        for (const refId of refIds) {
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

    // Dialog accessible name
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

    // Button type, accessible name, and WCAG 2.2 SC 2.5.8 target size
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
      const hasAdequateTargetSize =
        /\b(min-h-6|min-w-6|p-\d|py-\d|px-\d|h-\d|underline)\b/.test(cls);
      if (!hasAdequateTargetSize) {
        violations.push(
          `target-size (WCAG 2.2 SC 2.5.8): ${testId} lacks >=24px target sizing class ("${cls}")`
        );
      }
    }

    // Form controls: input, select, textarea
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

    // Native <progress> accessible name & value bounds
    if (tag === 'progress') {
      const ariaLabel = typeof props['aria-label'] === 'string' ? props['aria-label'].trim() : '';
      const ariaLabelledBy =
        typeof props['aria-labelledby'] === 'string' ? props['aria-labelledby'].trim() : '';
      if (!ariaLabel && !ariaLabelledBy) {
        violations.push(`progressbar-name: <progress> lacks accessible name`);
      }
      if (props.value !== undefined) {
        const num = Number(props.value);
        if (!Number.isFinite(num) || num < 0 || num > Number(props.max ?? 100)) {
          violations.push(`progressbar-value: <progress> has out-of-range value=${String(props.value)}`);
        }
      }
    }

    // Contrast class hygiene on dark wizard surfaces (4.5:1 AA minimum for text; inactive disabled controls exempt per WCAG 2.2 SC 1.4.3)
    if (
      tag !== 'svg' &&
      tag !== 'path' &&
      props['aria-hidden'] !== 'true' &&
      props['aria-hidden'] !== true &&
      props.disabled !== true
    ) {
      const cls = String(props.className || '');
      if (/\btext-(?:slate|gray|zinc)-[56789]00\b/.test(cls) && extractVNodeText(el).trim().length > 0) {
        violations.push(`color-contrast: ${testId} uses low-contrast muted text class ("${cls}")`);
      }
    }
  }

  return violations;
}

// ============================================================================
// Main Test Suite
// ============================================================================

describe('System Setup & Environment Health Wizard — Dual-OS Hermetic Verification Suite', () => {
  const tempDirs: string[] = [];

  function makeIsolatedEnv(prefix: string): { rootDir: string; homedir: string; userDataDir: string } {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `ol-env-wiz-${prefix}-`));
    tempDirs.push(rootDir);
    const homedir = path.join(rootDir, 'Users', 'testuser');
    const userDataDir = path.join(rootDir, 'AppData', 'OneLauncherUserData');
    fs.mkdirSync(homedir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    return { rootDir, homedir, userDataDir };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    environmentProvisioner.cancelEnvironmentSetup();
    environmentProvisioner.cancelGuidedClientLogin();
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
  // 1. Clean System Health Probes (Dual-OS & Dual-Arch + Zero-Write Guarantee)
  // ==========================================================================
  describe('1. Clean System Health Probes & Read-Only Zero-Write Guarantee', () => {
    it('1.1 probes a clean Apple Silicon Mac (darwin arm64) with exact recommendation tiers and zero filesystem writes', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('clean-mac-arm64');
      const homeBefore = listFilesRecursively(homedir);
      const userDataBefore = listFilesRecursively(userDataDir);

      const snapshot: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: false,
          savedTokens: {},
          connectedStorefronts: [],
        });

      // Strict read-only invariant: zero files/folders created or mutated in homedir or userDataDir
      expect(listFilesRecursively(homedir)).toEqual(homeBefore);
      expect(listFilesRecursively(userDataDir)).toEqual(userDataBefore);

      expect(snapshot.hostPlatform).toBe('darwin');
      expect(snapshot.hostArch).toBe('arm64');
      expect(snapshot.isAppleSiliconMac).toBe(true);

      // OS prerequisites
      expect(snapshot.components.rosetta2.status).toBe('missing');
      expect(snapshot.components.rosetta2.recommendationTier).toBe('required');
      expect(snapshot.components.rosetta2.defaultSelected).toBe(true);
      expect(snapshot.components.win_vcredist.status).toBe('not_applicable');
      expect(snapshot.components.win_webview2.status).toBe('not_applicable');

      // Compatibility runners & bottle defaults
      expect(snapshot.components.runner_crossover.status).toBe('missing');
      expect(snapshot.components.runner_crossover.recommendationTier).toBe('recommended');
      expect(snapshot.components.runner_crossover.defaultSelected).toBe(true);
      expect(snapshot.components.runner_wine.recommendationTier).toBe('optional');
      expect(snapshot.components.runner_wine.defaultSelected).toBe(false);
      expect(snapshot.components.runner_gptk.recommendationTier).toBe('optional');
      expect(snapshot.components.runner_gptk.defaultSelected).toBe(false);
      expect(snapshot.components.runner_gptk.requiresExternalDownload).toBe(true);

      expect(snapshot.components.bottle_default.status).toBe('missing');
      expect(snapshot.components.bottle_default.recommendationTier).toBe('recommended');
      expect(snapshot.components.bottle_default.defaultSelected).toBe(true);
      expect(snapshot.bottleSummary.recommendedBottleMode).toBe('create_dedicated');
      expect(snapshot.bottleSummary.recommendedBottleName).toBe('OneLauncher');

      // Storefront clients: Steam recommended; GOG optional (gogdl); Epic not_needed (legendary/EOS); Xbox built_in
      expect(snapshot.components.host_steam.recommendationTier).toBe('recommended');
      expect(snapshot.components.host_steam.defaultSelected).toBe(true);
      expect(snapshot.components.bottle_steam.recommendationTier).toBe('recommended');
      expect(snapshot.components.bottle_steam.defaultSelected).toBe(true);

      expect(snapshot.components.host_gog.recommendationTier).toBe('optional');
      expect(snapshot.components.host_gog.defaultSelected).toBe(false);
      expect(snapshot.components.host_gog.whyExplanation).toContain('gogdl');
      expect(snapshot.components.bottle_gog.recommendationTier).toBe('optional');
      expect(snapshot.components.bottle_gog.defaultSelected).toBe(false);
      expect(snapshot.components.bottle_gog.whyExplanation).toContain('gogdl');

      expect(snapshot.components.host_epic.recommendationTier).toBe('not_needed');
      expect(snapshot.components.host_epic.defaultSelected).toBe(false);
      expect(snapshot.components.host_epic.whyExplanation).toContain('legendary');
      expect(snapshot.components.bottle_epic.recommendationTier).toBe('not_needed');
      expect(snapshot.components.bottle_epic.defaultSelected).toBe(false);
      expect(snapshot.components.bottle_epic.whyExplanation).toContain('legendary');

      expect(snapshot.components.xbox_runtime.recommendationTier).toBe('built_in');
      expect(snapshot.components.xbox_runtime.status).toBe('ready');
      expect(snapshot.components.xbox_runtime.defaultSelected).toBe(false);

      const defaultSelected = computeDefaultSelectedComponents(snapshot);
      expect(Array.from(defaultSelected).sort()).toEqual(
        ['bottle_default', 'bottle_steam', 'host_steam', 'rosetta2', 'runner_crossover'].sort()
      );
      expect(defaultSelected.has('host_gog')).toBe(false);
      expect(defaultSelected.has('bottle_gog')).toBe(false);
      expect(defaultSelected.has('host_epic')).toBe(false);
      expect(defaultSelected.has('bottle_epic')).toBe(false);
    });

    it('1.2 marks rosetta2 as not_applicable on clean Intel Mac (darwin x64)', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('clean-mac-x64');

      const snapshot: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'x64',
          homedir,
          userDataDir,
          savedTokens: {},
          connectedStorefronts: [],
        });

      expect(snapshot.isAppleSiliconMac).toBe(false);
      expect(snapshot.components.rosetta2.status).toBe('not_applicable');
      expect(snapshot.components.rosetta2.recommendationTier).toBe('not_needed');
      expect(snapshot.components.rosetta2.defaultSelected).toBe(false);
      expect(snapshot.components.runner_crossover.status).toBe('missing');
      expect(snapshot.components.runner_crossover.defaultSelected).toBe(true);
      expect(snapshot.components.bottle_default.defaultSelected).toBe(true);

      const selected = computeDefaultSelectedComponents(snapshot);
      expect(selected.has('rosetta2')).toBe(false);
      expect(selected.has('runner_crossover')).toBe(true);
    });

    it('1.3 probes a clean Windows 11 PC (win32 x64) with win_vcredist selected and macOS runners/bottles not_applicable', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('clean-win32-x64');

      const snapshot: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'win32',
          arch: 'x64',
          homedir,
          userDataDir,
          vcRedistInstalled: false,
          webview2Installed: true,
          webview2Version: '131.0.2903.70',
          gamingServicesInstalled: true,
          savedTokens: {},
          connectedStorefronts: [],
        });

      expect(snapshot.hostPlatform).toBe('win32');
      expect(snapshot.components.win_vcredist.status).toBe('missing');
      expect(['required', 'recommended']).toContain(
        snapshot.components.win_vcredist.recommendationTier
      );
      expect(snapshot.components.win_vcredist.defaultSelected).toBe(true);
      expect(snapshot.components.win_webview2.status).toBe('ready');
      expect(snapshot.components.xbox_runtime.status).toBe('ready');

      for (const macOnlyId of [
        'rosetta2',
        'runner_crossover',
        'runner_crossover_preview',
        'runner_wine',
        'runner_gptk',
        'bottle_default',
        'bottle_steam',
        'bottle_gog',
        'bottle_epic',
      ] as const) {
        expect(snapshot.components[macOnlyId].status).toBe('not_applicable');
        expect(snapshot.components[macOnlyId].defaultSelected).toBe(false);
      }

      expect(snapshot.components.host_steam.status).toBe('missing');
      expect(snapshot.components.host_steam.defaultSelected).toBe(true);
      expect(snapshot.components.host_gog.defaultSelected).toBe(false);
      expect(snapshot.components.host_epic.defaultSelected).toBe(false);

      const selected = computeDefaultSelectedComponents(snapshot, []);
      expect(Array.from(selected).sort()).toEqual(['host_steam', 'win_vcredist']);

      // Fallback renderer snapshot parity for win32
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      const fallbackWin = buildFallbackEnvironmentSnapshot(['steam']);
      expect(fallbackWin.components.win_vcredist.defaultSelected).toBe(true);
      expect(fallbackWin.components.win_vcredist.recommendationTier).toBe('required');
      expect(fallbackWin.components.rosetta2.status).toBe('not_applicable');
      expect(fallbackWin.components.bottle_default.status).toBe('not_applicable');
    });
  });

  // ==========================================================================
  // 2. Partial System Reuse & Removed Component Drift Detection
  // ==========================================================================
  describe('2. Partial System Reuse & Removed Component Drift Detection', () => {
    it('2.1 reuses existing CrossOver + "Steam" bottle with Steam.exe without re-selecting ready components or forcing optional GOG', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('partial-mac');
      seedMockCrossOverApp(path.join(homedir, 'Applications'), '26.0.0');
      seedInitializedCrossOverBottle(homedir, 'Steam', {
        withSteam: true,
        withGogGalaxy: false,
        sandboxed: true,
      });

      const snapshot: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: true,
          connectedStorefronts: ['steam', 'gog'],
          savedTokens: {
            steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY },
            gog: { access_token: 'gog_valid_tok_123456', user_id: SYNTHETIC_GOG_USER_ID_PRIMARY },
          },
        });

      expect(snapshot.components.rosetta2.status).toBe('ready');
      expect(snapshot.components.runner_crossover.status).toBe('ready');
      expect(snapshot.components.runner_crossover.defaultSelected).toBe(false);
      expect(snapshot.components.bottle_default.status).toBe('ready');
      expect(snapshot.components.bottle_default.defaultSelected).toBe(false);
      expect(snapshot.bottleSummary.recommendedBottleMode).toBe('reuse_existing');
      expect(snapshot.bottleSummary.recommendedBottleName).toBe('Steam');
      expect(snapshot.components.bottle_steam.status).toBe('ready');
      expect(snapshot.components.bottle_steam.defaultSelected).toBe(false);

      // GOG remains optional & unchecked even when GOG account is connected
      expect(snapshot.components.host_gog.recommendationTier).toBe('optional');
      expect(snapshot.components.host_gog.defaultSelected).toBe(false);
      expect(snapshot.components.bottle_gog.recommendationTier).toBe('optional');
      expect(snapshot.components.bottle_gog.defaultSelected).toBe(false);

      const selected = computeDefaultSelectedComponents(snapshot, ['steam', 'gog'], {
        chosenRunner: 'crossover',
      });
      expect(selected.has('rosetta2')).toBe(false);
      expect(selected.has('runner_crossover')).toBe(false);
      expect(selected.has('bottle_default')).toBe(false);
      expect(selected.has('bottle_steam')).toBe(false);
      expect(selected.has('host_gog')).toBe(false);
      expect(selected.has('bottle_gog')).toBe(false);
      // Only host_steam is still missing among recommended components
      expect(Array.from(selected)).toEqual(['host_steam']);

      // Even if ready items were in selectedIds, buildProvisioningTasksFromSelection skips them unless forceRepairIds is set
      const tasksWithoutForce = buildProvisioningTasksFromSelection({
        snapshot,
        selectedIds: new Set(['runner_crossover', 'bottle_default', 'bottle_steam']),
        chosenRunner: 'crossover',
        bottleMode: 'reuse_existing',
        bottleName: 'Steam',
      });
      expect(tasksWithoutForce).toHaveLength(0);
    });

    it('2.2 detects externally deleted previously-configured components (wasPreviouslyConfigured & removedSinceLastSetupCount)', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('drift-mac');
      seedMockCrossOverApp(path.join(homedir, 'Applications'), '26.0.0');
      const bottlePath = seedInitializedCrossOverBottle(homedir, 'OneLauncher', {
        withSteam: true,
        withGogGalaxy: true,
      });

      const hostSteamApp = path.join(homedir, 'Applications/Steam.app');
      const hostSteamBin = path.join(hostSteamApp, 'Contents/MacOS/steam_osx');
      fs.mkdirSync(path.dirname(hostSteamBin), { recursive: true });
      fs.writeFileSync(hostSteamBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const saveRes = environmentHealthProber.saveSetupWizardState(
        {
          completedAt: '2026-10-01T00:00:00.000Z',
          configuredComponents: ['runner_crossover', 'bottle_default', 'host_steam', 'bottle_gog'],
        },
        { homedir, userDataDir }
      );
      expect(saveRes.success).toBe(true);

      // Probe 1: everything present -> 0 removed components
      const snapHealthy: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: true,
        });
      expect(snapHealthy.counts.removedSinceLastSetupCount).toBe(0);
      expect(getRemovedComponents(snapHealthy)).toHaveLength(0);

      // Simulate user deleting Steam.app and bottled GalaxyClient.exe outside One Launcher
      fs.rmSync(hostSteamApp, { recursive: true, force: true });
      fs.rmSync(path.join(bottlePath, 'drive_c/Program Files (x86)/GOG Galaxy'), {
        recursive: true,
        force: true,
      });

      // Probe 2: drift accurately detected
      const snapDrifted: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: true,
        });

      expect(snapDrifted.components.host_steam.status).toBe('missing');
      expect(snapDrifted.components.host_steam.wasPreviouslyConfigured).toBe(true);
      expect(snapDrifted.components.host_steam.statusDetail).toContain(
        'Previously Installed — Removed'
      );

      expect(snapDrifted.components.bottle_gog.status).toBe('missing');
      expect(snapDrifted.components.bottle_gog.wasPreviouslyConfigured).toBe(true);
      expect(snapDrifted.components.bottle_gog.statusDetail).toContain(
        'Previously Installed — Removed'
      );

      expect(snapDrifted.counts.removedSinceLastSetupCount).toBe(2);
      expect(getRemovedComponents(snapDrifted).map((c) => c.id)).toEqual([
        'host_steam',
        'bottle_gog',
      ]);
    });
  });

  // ==========================================================================
  // 3. Zero-Homebrew Provisioner & Cryptographic Supply-Chain Gate
  // ==========================================================================
  describe('3. Zero-Homebrew Provisioner & Cryptographic Supply-Chain Gate', () => {
    it('3.1 enforces strict HTTPS + pinned vendor allowlist + SSRF IP/loopback/redirect blocking in validateInstallerUrl', async () => {
      // Blocked: non-HTTPS
      expect(() =>
        environmentProvisioner.validateInstallerUrl(
          'http://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe'
        )
      ).toThrow(/Non-HTTPS/i);

      // Blocked: untrusted domain
      expect(() =>
        environmentProvisioner.validateInstallerUrl('https://evil-mirror.example.com/CrossOver.zip')
      ).toThrow(/Untrusted installer host/i);

      // Blocked: embedded URL credentials
      expect(() =>
        environmentProvisioner.validateInstallerUrl(
          'https://admin:secret@cdn.fastly.steamstatic.com/client/installer/steam.dmg'
        )
      ).toThrow(/Credentials in installer URL are forbidden/i);

      // Blocked: AWS/cloud link-local & RFC1918 private IPs & IPv6 literals
      for (const ssrfUrl of [
        'https://169.254.169.254/latest/meta-data/',
        'https://10.0.0.15/installer.exe',
        'https://192.168.1.50/installer.exe',
        'https://172.20.0.5/installer.exe',
        'https://[fe80::1]/installer.exe',
        'http://127.0.0.1:9000/CrossOver.zip',
        'https://localhost:8443/CrossOver.zip',
      ]) {
        expect(() => environmentProvisioner.validateInstallerUrl(ssrfUrl)).toThrow(/SSRF policy/i);
      }

      // Loopback allowed ONLY with explicit internal test option allowLoopbackInstallerUrls: true
      expect(
        environmentProvisioner.validateInstallerUrl('http://127.0.0.1:18999/CrossOver.zip', {
          allowLoopbackInstallerUrls: true,
        })
      ).toBe('http://127.0.0.1:18999/CrossOver.zip');

      // Allowed: pinned official vendor HTTPS endpoints
      for (const validUrl of [
        'https://www.codeweavers.com/xml/versions/cxmac.xml',
        'https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-26.0.0.zip',
        'https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe',
        'https://aka.ms/vs/17/release/vc_redist.x64.exe',
        'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncher.dmg',
      ]) {
        expect(environmentProvisioner.validateInstallerUrl(validUrl)).toBe(validUrl);
      }

      // Redirect SSRF / host-escape guard: 302 from allowlisted host to untrusted host is blocked before fetching target
      const { homedir, userDataDir } = makeIsolatedEnv('redirect-guard');
      const requestedUrls: string[] = [];
      const redirectResult = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          runId: 'run-redirect-block',
          tasks: [{ action: 'install_client', componentId: 'host_steam' }],
        },
        {
          platform: 'win32',
          homedir,
          userDataDir,
          vcRedistInstalled: false,
          webview2Installed: false,
          gamingServicesInstalled: false,
          fetchFn: async (url: string) => {
            requestedUrls.push(url);
            return buildMockFetchResponse({
              status: 302,
              body: '',
              headers: { location: 'https://attacker.example.org/SteamSetup.exe' },
            });
          },
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => {
            cb(new Error('not found'), '', '');
            return {};
          },
        }
      );
      expect(redirectResult.success).toBe(false);
      expect(redirectResult.outcomes[0].status).toBe('failed');
      expect(redirectResult.outcomes[0].error).toMatch(/Untrusted installer host/i);
      expect(requestedUrls).toEqual([
        'https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe',
      ]);
    });

    it('3.2 rejects unsigned/tampered .app, .pkg, and .exe installers and immediately purges staged artifacts', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('sig-reject');

      // A) Tampered / ad-hoc signed CrossOver.app -> rejected & staged .app deleted before copying to ~/Applications
      let capturedStagedAppPath = '';
      const badAppRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          runId: 'run-bad-app',
          tasks: [
            { action: 'install_runner', componentId: 'runner_crossover', runnerType: 'crossover' },
          ],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: true,
          fetchFn: async (url: string) => {
            if (url.endsWith('cxmac.xml')) {
              return buildMockFetchResponse({
                body: `<rss><channel><item><enclosure url="https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-26.0.0.zip" sparkle:version="26.0.0"/></item></channel></rss>`,
              });
            }
            return buildMockFetchResponse({ body: Buffer.alloc(2048, 0x50) });
          },
          onExtractArchive: async (_archivePath: string, stagingDir: string) => {
            capturedStagedAppPath = seedMockCrossOverApp(stagingDir, '26.0.0');
          },
          execFileFn: (cmd: string, args: string[], _opts: any, cb: Function) => {
            if (cmd === '/usr/bin/codesign' && args[0] === '--verify') {
              cb(null, '', '');
              return {};
            }
            if (cmd === '/usr/bin/codesign' && args[0] === '-dv') {
              cb(null, '', 'Signature=adhoc\nTeamIdentifier=not set\n');
              return {};
            }
            cb(new Error(`Unexpected command: ${cmd}`), '', '');
            return {};
          },
        }
      );

      expect(badAppRes.success).toBe(false);
      expect(badAppRes.outcomes[0].status).toBe('failed');
      expect(badAppRes.outcomes[0].error).toMatch(/ad-hoc|signature verification failed/i);
      expect(capturedStagedAppPath).not.toBe('');
      expect(fs.existsSync(capturedStagedAppPath)).toBe(false);
      expect(fs.existsSync(path.join(homedir, 'Applications/CrossOver.app'))).toBe(false);

      // B) Unsigned macOS .pkg -> verifyMacPkgSignature throws and unlinks .pkg immediately
      const unsignedPkgPath = path.join(userDataDir, 'Tampered_Galaxy.pkg');
      fs.writeFileSync(unsignedPkgPath, Buffer.alloc(1024, 0xaa));
      await expect(
        environmentProvisioner.verifyMacPkgSignature(unsignedPkgPath, {
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => {
            cb(null, 'Package "Tampered_Galaxy.pkg":\n   Status: no signature\n', '');
            return {};
          },
        })
      ).rejects.toThrow(/Package signature verification failed/i);
      expect(fs.existsSync(unsignedPkgPath)).toBe(false);

      // C) Unsigned PE64 .exe on darwin (missing WIN_CERTIFICATE DataDirectory[4]) -> rejected & unlinked
      const unsignedExePath = path.join(userDataDir, 'UnsignedSteamSetup.exe');
      fs.writeFileSync(
        unsignedExePath,
        buildSyntheticInstallerPe64Buffer({ withAuthenticode: false })
      );
      expect(environmentProvisioner.hasEmbeddedPeAuthenticodeCertificate(unsignedExePath)).toBe(
        false
      );
      await expect(
        environmentProvisioner.verifyWindowsInstallerSignature(unsignedExePath, {
          platform: 'darwin',
          kind: 'exe',
        })
      ).rejects.toThrow(/missing an embedded Authenticode WIN_CERTIFICATE/i);
      expect(fs.existsSync(unsignedExePath)).toBe(false);

      // D) Tampered .exe on win32 (Get-AuthenticodeSignature != 'Valid') -> rejected & unlinked before execution
      const tamperedWinExePath = path.join(userDataDir, 'TamperedVcRedist.exe');
      fs.writeFileSync(
        tamperedWinExePath,
        buildSyntheticInstallerPe64Buffer({ withAuthenticode: true })
      );
      await expect(
        environmentProvisioner.verifyWindowsInstallerSignature(tamperedWinExePath, {
          platform: 'win32',
          kind: 'exe',
          execFileFn: (_cmd: string, _args: string[], _opts: any, cb: Function) => {
            cb(null, 'HashMismatch\r\n', '');
            return {};
          },
        })
      ).rejects.toThrow(/HashMismatch/i);
      expect(fs.existsSync(tamperedWinExePath)).toBe(false);
    });

    it('3.3 provisions Rosetta 2 -> CrossOver -> sandboxed OneLauncher bottle -> bottled Steam end-to-end with zero Homebrew and verifies win32 VC++ exit 3010', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('provision-e2e');
      const signedPeBuf = buildSyntheticInstallerPe64Buffer({ withAuthenticode: true });

      const progressEvents: EnvironmentSetupProgressEvent[] = [];
      const unsubscribe = environmentProvisioner.onEnvironmentSetupProgress(
        (evt: EnvironmentSetupProgressEvent) => {
          progressEvents.push(evt);
        }
      );

      const executedCommands: Array<{ cmd: string; args: string[] }> = [];
      let rosettaInstalledFlag = false;

      try {
        // Submit tasks intentionally out of order to verify topological dependency sorting:
        // install_rosetta2 (0) -> install_runner (1) -> ensure_bottle (2) -> install_client (3)
        const result = await environmentProvisioner.runEnvironmentSetupTasks(
          {
            runId: 'run-mac-full-e2e',
            connectedStorefronts: ['steam'],
            tasks: [
              {
                action: 'install_client',
                componentId: 'bottle_steam',
                runnerType: 'crossover',
                bottleName: 'OneLauncher',
              },
              {
                action: 'ensure_bottle',
                componentId: 'bottle_default',
                runnerType: 'crossover',
                bottleMode: 'create_dedicated',
                bottleName: 'OneLauncher',
              },
              {
                action: 'install_runner',
                componentId: 'runner_crossover',
                runnerType: 'crossover',
              },
              {
                action: 'install_rosetta2',
                componentId: 'rosetta2',
              },
            ],
          },
          {
            platform: 'darwin',
            arch: 'arm64',
            homedir,
            userDataDir,
            disableProgressThrottle: true,
            get rosettaInstalled() {
              return rosettaInstalledFlag;
            },
            fetchFn: async (url: string) => {
              if (url.endsWith('cxmac.xml')) {
                return buildMockFetchResponse({
                  body: `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <item>
      <enclosure url="https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-26.0.0.zip" sparkle:version="26.0.0" />
    </item>
  </channel>
</rss>`,
                });
              }
              if (url.endsWith('crossover-26.0.0.zip')) {
                return buildMockFetchResponse({ body: Buffer.alloc(4096, 0x43) });
              }
              if (url.endsWith('SteamSetup.exe')) {
                return buildMockFetchResponse({ body: signedPeBuf });
              }
              throw new Error(`Unexpected fetch URL in hermetic test: ${url}`);
            },
            onExtractArchive: async (_archivePath: string, stagingDir: string) => {
              seedMockCrossOverApp(stagingDir, '26.0.0');
            },
            execFileFn: (cmd: string, args: string[], _opts: any, cb: Function) => {
              executedCommands.push({ cmd, args });
              if (cmd === '/usr/sbin/softwareupdate') {
                rosettaInstalledFlag = true;
                cb(null, 'Install of Rosetta 2 finished successfully\n', '');
                return {};
              }
              if (cmd === '/usr/bin/codesign' && args[0] === '--verify') {
                cb(null, '', '');
                return {};
              }
              if (cmd === '/usr/bin/codesign' && args[0] === '-dv') {
                // Real CodeWeavers Developer ID output format
                cb(
                  null,
                  '',
                  [
                    'Executable=/Applications/CrossOver.app/Contents/MacOS/CrossOver',
                    'Identifier=com.codeweavers.CrossOver',
                    'Authority=Developer ID Application: CodeWeavers Inc. (G78RJ6NLJU)',
                    'Authority=Developer ID Certification Authority',
                    'Authority=Apple Root CA',
                    'TeamIdentifier=G78RJ6NLJU',
                  ].join('\n')
                );
                return {};
              }
              if (cmd === '/usr/bin/ditto') {
                const [srcApp, destApp] = args;
                fs.cpSync(srcApp, destApp, { recursive: true, force: true });
                cb(null, '', '');
                return {};
              }
              if (cmd === '/usr/bin/xattr') {
                cb(null, '', '');
                return {};
              }
              if (cmd.endsWith('/cxbottle')) {
                // Simulate cxbottle creating a fresh prefix with an unsandboxed ~/Documents symlink
                seedInitializedCrossOverBottle(homedir, 'OneLauncher', {
                  withSteam: false,
                  sandboxed: false,
                });
                cb(null, 'Bottle OneLauncher created\n', '');
                return {};
              }
              cb(null, '', '');
              return {};
            },
            execBottleInstallerFn: async ({
              bottlePath,
              args,
            }: {
              bottlePath: string;
              args: string[];
            }) => {
              expect(args[1]).toBe('/S');
              expect(args[0]).toContain('SteamSetup.exe');
              const steamDir = path.join(bottlePath, 'drive_c/Program Files (x86)/Steam');
              fs.mkdirSync(steamDir, { recursive: true });
              fs.writeFileSync(path.join(steamDir, 'steam.exe'), 'MZ-INSTALLED-STEAM', 'utf8');
            },
          }
        );

        expect(result.success).toBe(true);
        expect(result.outcomes.map((o: any) => o.componentId)).toEqual([
          'rosetta2',
          'runner_crossover',
          'bottle_default',
          'bottle_steam',
        ]);
        expect(result.outcomes.every((o: any) => o.status === 'completed')).toBe(true);

        // Zero Homebrew invocations anywhere
        expect(
          executedCommands.some(({ cmd, args }) => /brew/i.test(cmd) || args.some((a) => /brew/i.test(a)))
        ).toBe(false);

        // Verify bottle Documents symlink was replaced with a real sandboxed directory inside the bottle
        const bottleDocs = path.join(
          homedir,
          'Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/users/crossover/Documents'
        );
        expect(fs.lstatSync(bottleDocs).isSymbolicLink()).toBe(false);
        expect(fs.lstatSync(bottleDocs).isDirectory()).toBe(true);

        // Verify persisted setup-wizard-state.json recorded all 4 configured components
        const persisted = environmentHealthProber.getSetupWizardState({ homedir, userDataDir });
        expect(persisted.preferredRunnerType).toBe('crossover');
        expect(persisted.preferredBottleName).toBe('OneLauncher');
        expect(persisted.configuredComponents).toEqual(
          expect.arrayContaining(['rosetta2', 'runner_crossover', 'bottle_default', 'bottle_steam'])
        );

        // Verify post-run snapshot reports components ready
        expect(result.snapshot.components.rosetta2.status).toBe('ready');
        expect(result.snapshot.components.runner_crossover.status).toBe('ready');
        expect(result.snapshot.components.bottle_default.status).toBe('ready');
        expect(result.snapshot.components.bottle_steam.status).toBe('ready');

        // Verify progress events emitted across phases
        const phases = new Set(progressEvents.map((e) => e.phase));
        expect(phases.has('downloading')).toBe(true);
        expect(phases.has('verifying_signature')).toBe(true);
        expect(phases.has('configuring_bottle')).toBe(true);
        expect(phases.has('completed')).toBe(true);
      } finally {
        unsubscribe();
      }

      // Windows VC++ Redistributable: exit code 3010 (reboot required) succeeds cleanly
      const winEnv = makeIsolatedEnv('provision-win-vcredist');
      let vcInstalled = false;
      const winRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          runId: 'run-win-vcredist',
          tasks: [{ action: 'install_win_vcredist', componentId: 'win_vcredist' }],
        },
        {
          platform: 'win32',
          arch: 'x64',
          x64Only: true,
          homedir: winEnv.homedir,
          userDataDir: winEnv.userDataDir,
          get vcRedistInstalled() {
            return vcInstalled;
          },
          fetchFn: async () => buildMockFetchResponse({ body: signedPeBuf }),
          execFileFn: (cmd: string, args: string[], _opts: any, cb: Function) => {
            if (cmd === 'powershell.exe') {
              cb(null, 'Valid\r\n', '');
              return {};
            }
            if (cmd.endsWith('vc_redist.x64.exe')) {
              expect(args).toEqual(['/install', '/quiet', '/norestart']);
              vcInstalled = true;
              const rebootReqErr: any = new Error('Reboot required');
              rebootReqErr.code = 3010;
              cb(rebootReqErr, '', '');
              return {};
            }
            cb(null, '', '');
            return {};
          },
        }
      );
      expect(winRes.success).toBe(true);
      expect(winRes.outcomes[0].status).toBe('completed');
      expect(winRes.snapshot.components.win_vcredist.status).toBe('ready');
    });

    it('3.4 dynamically resolves zero-hardcoded-version GOG Galaxy URLs, recovers from Tier 1/2 HTTP 404s, and immediately rethrows SSRF/untrusted-host violations', async () => {
      // A) Static invariant: zero hardcoded setup_galaxy_2.* or galaxy_client_2.* version strings in provisioner
      const provisionerPath = path.resolve(
        __dirname,
        '../electron/launcher/environmentProvisioner.cjs'
      );
      const provisionerSource = fs.readFileSync(provisionerPath, 'utf8');
      expect(provisionerSource).not.toMatch(/setup_galaxy_2\.\d/i);
      expect(provisionerSource).not.toMatch(/galaxy_client_2\.\d/i);

      // B) Tier 1: remote-config.gog.com uses ?component_version=2.0.0 (never ?version=2.0.0) for windows & osx
      const tier1QueriedUrls: string[] = [];
      const tier1Payload = JSON.stringify({
        content: {
          windows: {
            downloadLink:
              'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_2.99.0.1.exe',
          },
          osx: {
            downloadLink:
              'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/galaxy_client_2.99.0.1.pkg',
          },
        },
      });
      const tier1FetchFn = async (url: string) => {
        tier1QueriedUrls.push(url);
        return buildMockFetchResponse({ body: tier1Payload });
      };

      const winTier1Url = await environmentProvisioner.resolveGogGalaxyInstallerUrl('windows', {
        fetchFn: tier1FetchFn,
      });
      const macTier1Url = await environmentProvisioner.resolveGogGalaxyInstallerUrl('osx', {
        fetchFn: tier1FetchFn,
      });

      expect(winTier1Url).toBe(
        'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_2.99.0.1.exe'
      );
      expect(macTier1Url).toBe(
        'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/galaxy_client_2.99.0.1.pkg'
      );
      expect(tier1QueriedUrls).toHaveLength(2);
      for (const queried of tier1QueriedUrls) {
        expect(queried).toContain('component_version=2.0.0');
        expect(queried).not.toContain('?version=2.0.0');
      }

      // C) Multi-tier HTTP 404 retry: Tier 1 binary returns 404 -> Tier 2 webpage derives 2.99.1.7 -> 302 CDN -> 200 OK
      const { homedir } = makeIsolatedEnv('gog-multitier-dl');
      const signedPeBuf = buildSyntheticInstallerPe64Buffer({ withAuthenticode: true });
      const syntheticPkgBuf = Buffer.from('xar!-synthetic-gog-pkg-payload');

      const destTier2WinExe = path.join(homedir, 'downloads/GOG_Tier2_Recovered.exe');
      const tier2RecoveryVisited: string[] = [];
      const tier2RecoveryRes = await environmentProvisioner.downloadGogGalaxyInstallerToFile(
        'windows',
        destTier2WinExe,
        {
          runId: 'gog-t2-recovery',
          componentId: 'bottle_gog',
          label: 'Windows GOG Galaxy Installer',
        },
        {
          disableProgressThrottle: true,
          fetchFn: async (url: string) => {
            tier2RecoveryVisited.push(url);
            if (url.startsWith('https://remote-config.gog.com/')) {
              return buildMockFetchResponse({
                body: JSON.stringify({
                  content: {
                    windows: {
                      downloadLink:
                        'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_2.0.81.106.exe',
                    },
                  },
                }),
              });
            }
            if (url.includes('setup_galaxy_2.0.81.106.exe')) {
              return buildMockFetchResponse({ status: 404, body: 'Not Found' });
            }
            if (url === 'https://www.gog.com/en/galaxy') {
              return buildMockFetchResponse({
                body: '<html><body><a href="https://cdn.gog.com/open/galaxy/client/galaxy_client_2.99.1.7.pkg">Download Mac</a></body></html>',
              });
            }
            if (
              url ===
              'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_2.99.1.7.exe'
            ) {
              return buildMockFetchResponse({
                status: 302,
                body: '',
                headers: {
                  location:
                    'https://gog-cdn-fastly.gog.com/open/galaxy/client/setup_galaxy_2.99.1.7.exe',
                },
              });
            }
            if (
              url === 'https://gog-cdn-fastly.gog.com/open/galaxy/client/setup_galaxy_2.99.1.7.exe'
            ) {
              return buildMockFetchResponse({ status: 200, body: signedPeBuf });
            }
            throw new Error(`Unexpected URL in Tier 2 recovery test: ${url}`);
          },
        }
      );

      expect(tier2RecoveryRes).toEqual({
        url: 'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_2.99.1.7.exe',
        isStubWebInstaller: false,
      });
      expect(fs.statSync(destTier2WinExe).size).toBe(signedPeBuf.length);
      expect(tier2RecoveryVisited).toContain(
        'https://gog-cdn-fastly.gog.com/open/galaxy/client/setup_galaxy_2.99.1.7.exe'
      );

      // Also verify macOS ('osx') Tier 1 404 -> Tier 2 .pkg recovery
      const destTier2MacPkg = path.join(homedir, 'downloads/GOG_Tier2_Recovered.pkg');
      const macTier2Res = await environmentProvisioner.downloadGogGalaxyInstallerToFile(
        'osx',
        destTier2MacPkg,
        {
          runId: 'gog-mac-t2',
          componentId: 'host_gog',
          label: 'GOG Galaxy for macOS',
        },
        {
          disableProgressThrottle: true,
          fetchFn: async (url: string) => {
            if (url.startsWith('https://remote-config.gog.com/')) {
              return buildMockFetchResponse({
                body: JSON.stringify({
                  content: {
                    osx: {
                      downloadLink:
                        'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/galaxy_client_2.0.81.106.pkg',
                    },
                  },
                }),
              });
            }
            if (url.includes('galaxy_client_2.0.81.106.pkg')) {
              return buildMockFetchResponse({ status: 404, body: 'Not Found' });
            }
            if (url === 'https://www.gog.com/en/galaxy') {
              return buildMockFetchResponse({
                body: '<script>window.__GOG_PKG__="galaxy_client_2.99.1.7.pkg";</script>',
              });
            }
            if (
              url ===
              'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/galaxy_client_2.99.1.7.pkg'
            ) {
              return buildMockFetchResponse({ status: 200, body: syntheticPkgBuf });
            }
            throw new Error(`Unexpected URL in macOS Tier 2 test: ${url}`);
          },
        }
      );
      expect(macTier2Res.isStubWebInstaller).toBe(false);
      expect(fs.readFileSync(destTier2MacPkg)).toEqual(syntheticPkgBuf);

      // D) Tier 1 (404) -> Tier 2 (404) -> Tier 3 evergreen stub (GOG_Galaxy_2.0.exe) fallback
      const stubPeBuf = buildSyntheticInstallerPe64Buffer({
        totalBytes: 200 * 1024,
        withAuthenticode: true,
      });
      const destTier3StubExe = path.join(homedir, 'downloads/GOG_Tier3_Stub.exe');
      const tier3Res = await environmentProvisioner.downloadGogGalaxyInstallerToFile(
        'windows',
        destTier3StubExe,
        {
          runId: 'gog-t3-stub',
          componentId: 'bottle_gog',
          label: 'Windows GOG Galaxy Installer',
        },
        {
          disableProgressThrottle: true,
          fetchFn: async (url: string) => {
            if (url.startsWith('https://remote-config.gog.com/')) {
              return buildMockFetchResponse({
                body: JSON.stringify({
                  content: {
                    windows: {
                      downloadLink:
                        'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_2.0.81.106.exe',
                    },
                  },
                }),
              });
            }
            if (url === 'https://www.gog.com/en/galaxy') {
              return buildMockFetchResponse({
                body: '<a href="https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_2.99.1.7.exe">Win</a>',
              });
            }
            if (url.includes('setup_galaxy_')) {
              return buildMockFetchResponse({ status: 404, body: 'Not Found' });
            }
            if (url === 'https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe') {
              return buildMockFetchResponse({ status: 200, body: stubPeBuf });
            }
            throw new Error(`Unexpected URL in Tier 3 stub test: ${url}`);
          },
        }
      );
      expect(tier3Res).toEqual({
        url: 'https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe',
        isStubWebInstaller: true,
      });
      expect(fs.statSync(destTier3StubExe).size).toBe(stubPeBuf.length);

      // E) Security invariant: untrusted host & loopback redirect rethrow immediately WITHOUT Tier 2/3 fallback
      const untrustedHostCalls: string[] = [];
      await expect(
        environmentProvisioner.downloadGogGalaxyInstallerToFile(
          'windows',
          path.join(homedir, 'downloads/blocked_host.exe'),
          {
            runId: 'gog-sec-host',
            componentId: 'bottle_gog',
            label: 'Windows GOG Galaxy Installer',
          },
          {
            fetchFn: async (url: string) => {
              untrustedHostCalls.push(url);
              return buildMockFetchResponse({
                body: JSON.stringify({
                  content: {
                    windows: { downloadLink: 'https://evil.example.com/setup.exe' },
                  },
                }),
              });
            },
          }
        )
      ).rejects.toMatchObject({
        code: 'INSTALLER_URL_BLOCKED',
        message: expect.stringMatching(/Untrusted installer host/i),
      });
      expect(untrustedHostCalls).toEqual([
        'https://remote-config.gog.com/components/webinstaller?component_version=2.0.0',
      ]);

      const loopbackRedirectCalls: string[] = [];
      await expect(
        environmentProvisioner.downloadGogGalaxyInstallerToFile(
          'windows',
          path.join(homedir, 'downloads/blocked_loopback.exe'),
          {
            runId: 'gog-sec-loopback',
            componentId: 'bottle_gog',
            label: 'Windows GOG Galaxy Installer',
          },
          {
            fetchFn: async (url: string) => {
              loopbackRedirectCalls.push(url);
              if (url.startsWith('https://remote-config.gog.com/')) {
                return buildMockFetchResponse({
                  body: JSON.stringify({
                    content: {
                      windows: {
                        downloadLink:
                          'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_2.99.2.0.exe',
                      },
                    },
                  }),
                });
              }
              return buildMockFetchResponse({
                status: 302,
                body: '',
                headers: { location: 'https://127.0.0.1/evil.exe' },
              });
            },
          }
        )
      ).rejects.toMatchObject({
        code: 'INSTALLER_URL_BLOCKED',
        message: expect.stringMatching(/Loopback installer URL blocked by SSRF policy/i),
      });
      // Must NOT fall back to www.gog.com/en/galaxy or webinstallers.gog-statics.com
      expect(loopbackRedirectCalls).not.toContain('https://www.gog.com/en/galaxy');
      expect(loopbackRedirectCalls).not.toContain(
        'https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe'
      );

      // F) Performance / heap guardrail: oversized webpage metadata (> maxTextBytes) is capped and falls back to Tier 3 stub
      const oversizedFallbackRes = await environmentProvisioner.downloadGogGalaxyInstallerToFile(
        'windows',
        path.join(homedir, 'downloads/GOG_Oversized_Html_Fallback.exe'),
        {
          runId: 'gog-oversized-html',
          componentId: 'bottle_gog',
          label: 'Windows GOG Galaxy Installer',
        },
        {
          maxTextBytes: 2048,
          disableProgressThrottle: true,
          fetchFn: async (url: string) => {
            if (url.startsWith('https://remote-config.gog.com/')) {
              return buildMockFetchResponse({ status: 503, body: 'Unavailable' });
            }
            if (url === 'https://www.gog.com/en/galaxy') {
              return buildMockFetchResponse({
                status: 200,
                headers: { 'content-length': '99999999' },
                body: 'x'.repeat(4096),
              });
            }
            if (url === 'https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe') {
              return buildMockFetchResponse({ status: 200, body: stubPeBuf });
            }
            throw new Error(`Unexpected URL in oversized HTML test: ${url}`);
          },
        }
      );
      expect(oversizedFallbackRes).toEqual({
        url: 'https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe',
        isStubWebInstaller: true,
      });
    });

    it('3.5 protects bottle installers with numeric child PIDs from early resolution & mid-extraction unlink while preserving mock spawnFn compatibility', async () => {
      const signedPeBuf = buildSyntheticInstallerPe64Buffer({ withAuthenticode: true });

      // A) Real numeric PID (pid: 42424): must NOT resolve or unlink GOG_Galaxy_Setup.exe until child exits
      const pidEnv = makeIsolatedEnv('gog-bottle-real-pid');
      seedMockCrossOverApp(path.join(pidEnv.homedir, 'Applications'), '26.0.0');
      const bottlePath = seedInitializedCrossOverBottle(pidEnv.homedir, 'OneLauncher');
      const bottleSetupExe = path.join(bottlePath, 'drive_c/windows/temp/GOG_Galaxy_Setup.exe');
      const targetGalaxyExe = path.join(
        bottlePath,
        'drive_c/Program Files (x86)/GOG Galaxy/GalaxyClient.exe'
      );

      let spawnedChild: (EventEmitter & { pid?: number; kill?: ReturnType<typeof vi.fn> }) | null =
        null;
      let runResolvedEarly = false;

      const runPromise = environmentProvisioner
        .runEnvironmentSetupTasks(
          {
            runId: 'run-bottle-gog-real-pid',
            tasks: [
              {
                action: 'install_client',
                componentId: 'bottle_gog',
                runnerType: 'crossover',
                bottleName: 'OneLauncher',
              },
            ],
          },
          {
            platform: 'darwin',
            arch: 'arm64',
            homedir: pidEnv.homedir,
            userDataDir: pidEnv.userDataDir,
            rosettaInstalled: true,
            bottlePollIntervalMs: 15,
            postExitFlushGraceMs: 15,
            fetchFn: async (url: string) => {
              if (url.startsWith('https://remote-config.gog.com/')) {
                return buildMockFetchResponse({
                  body: JSON.stringify({
                    content: {
                      windows: {
                        downloadLink:
                          'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_2.99.3.0.exe',
                      },
                    },
                  }),
                });
              }
              return buildMockFetchResponse({ status: 200, body: signedPeBuf });
            },
            spawnFn: () => {
              const proc = Object.assign(new EventEmitter(), {
                pid: 42424,
                kill: vi.fn(),
              });
              spawnedChild = proc;
              // Inno Setup writes GalaxyClient.exe early while still extracting companion DLLs
              fs.mkdirSync(path.dirname(targetGalaxyExe), { recursive: true });
              fs.writeFileSync(targetGalaxyExe, 'MZ-SYNTHETIC-GALAXY', 'utf8');
              return proc;
            },
          }
        )
        .then((res: any) => {
          runResolvedEarly = true;
          return res;
        });

      // Wait >3 poll intervals (50ms at 15ms poll): child is still running!
      await new Promise((r) => setTimeout(r, 50));
      expect(spawnedChild).not.toBeNull();
      expect(runResolvedEarly).toBe(false);
      // Staged GOG_Galaxy_Setup.exe inside bottle MUST still exist during extraction!
      expect(fs.existsSync(bottleSetupExe)).toBe(true);

      // Now emit child exit & close -> runBottleInstallerAndWait completes and cleans up staged setup exe
      spawnedChild!.emit('exit', 0);
      spawnedChild!.emit('close', 0);
      const realPidResult = await runPromise;

      expect(realPidResult.success).toBe(true);
      expect(realPidResult.outcomes[0].status).toBe('completed');
      expect(realPidResult.outcomes[0].installedPath).toBe(targetGalaxyExe);
      expect(fs.existsSync(bottleSetupExe)).toBe(false);

      // B) Mock spawnFn WITHOUT numeric pid: continues to resolve cleanly via binary poll
      const mockEnv = makeIsolatedEnv('gog-bottle-mock-pid');
      seedMockCrossOverApp(path.join(mockEnv.homedir, 'Applications'), '26.0.0');
      const mockBottlePath = seedInitializedCrossOverBottle(mockEnv.homedir, 'OneLauncher');
      const mockGalaxyExe = path.join(
        mockBottlePath,
        'drive_c/Program Files (x86)/GOG Galaxy/GalaxyClient.exe'
      );

      const mockPidResult = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          runId: 'run-bottle-gog-mock-pid',
          tasks: [
            {
              action: 'install_client',
              componentId: 'bottle_gog',
              runnerType: 'crossover',
              bottleName: 'OneLauncher',
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: mockEnv.homedir,
          userDataDir: mockEnv.userDataDir,
          rosettaInstalled: true,
          bottlePollIntervalMs: 15,
          fetchFn: async (url: string) => {
            if (url.startsWith('https://remote-config.gog.com/')) {
              return buildMockFetchResponse({
                body: JSON.stringify({
                  content: {
                    windows: {
                      downloadLink:
                        'https://content-system.gog.com/open_link/download?path=/open/galaxy/client/setup_galaxy_2.99.3.0.exe',
                    },
                  },
                }),
              });
            }
            return buildMockFetchResponse({ status: 200, body: signedPeBuf });
          },
          spawnFn: () => {
            setTimeout(() => {
              fs.mkdirSync(path.dirname(mockGalaxyExe), { recursive: true });
              fs.writeFileSync(mockGalaxyExe, 'MZ-SYNTHETIC-GALAXY', 'utf8');
            }, 10);
            return { on: vi.fn(), kill: vi.fn() };
          },
        }
      );

      expect(mockPidResult.success).toBe(true);
      expect(mockPidResult.outcomes[0].status).toBe('completed');
      expect(mockPidResult.outcomes[0].installedPath).toBe(mockGalaxyExe);
    });
  });

  // ==========================================================================
  // 4. Desktop & Bottled Client Auth Probes, Mismatch & Guided Sign-In Watcher
  // ==========================================================================
  describe('4. Client Auth Probes, Account Mismatch Detection & Guided Sign-In Watcher', () => {
    it('4.1 probes Steam loginusers.vdf, GOG Galaxy config.json + galaxy-2.0.db (node:sqlite), and Epic GameUserSettings.ini across host & bottle (matching, mismatching, and signed-out)', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('auth-probes');
      seedMockCrossOverApp(path.join(homedir, 'Applications'), '26.0.0');
      const bottlePath = seedInitializedCrossOverBottle(homedir, 'OneLauncher', {
        withSteam: true,
        withGogGalaxy: true,
        withEpicLauncher: true,
      });

      // Seed macOS host Steam, GOG Galaxy, and Epic Games Launcher binaries
      const hostSteamBin = path.join(homedir, 'Applications/Steam.app/Contents/MacOS/steam_osx');
      fs.mkdirSync(path.dirname(hostSteamBin), { recursive: true });
      fs.writeFileSync(hostSteamBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.mkdirSync(path.join(homedir, 'Applications/GOG Galaxy.app'), { recursive: true });
      fs.mkdirSync(path.join(homedir, 'Applications/Epic Games Launcher.app'), { recursive: true });

      // 1) Host Steam = matching account (76561198000000042); Bottled Steam = mismatched account (76561198099999999)
      const hostSteamVdf = path.join(
        homedir,
        'Library/Application Support/Steam/config/loginusers.vdf'
      );
      fs.mkdirSync(path.dirname(hostSteamVdf), { recursive: true });
      fs.writeFileSync(
        hostSteamVdf,
        buildSteamLoginUsersVdf([
          {
            steamId64: SYNTHETIC_STEAM_ID_PRIMARY,
            accountName: 'testplayer42',
            personaName: 'TestPlayer42',
            mostRecent: true,
            allowAutoLogin: true,
          },
        ]),
        'utf8'
      );

      const bottleSteamVdf = path.join(
        bottlePath,
        'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'
      );
      fs.mkdirSync(path.dirname(bottleSteamVdf), { recursive: true });
      fs.writeFileSync(
        bottleSteamVdf,
        buildSteamLoginUsersVdf([
          {
            steamId64: SYNTHETIC_STEAM_ID_MISMATCH,
            accountName: 'otherplayer99',
            personaName: 'OtherPlayer99',
            mostRecent: true,
            allowAutoLogin: true,
          },
        ]),
        'utf8'
      );

      // 2) Host GOG = matching user via config.json + real SQLite galaxy-2.0.db; Bottled GOG = mismatched userId
      const hostGogDir = path.join(homedir, 'Library/Application Support/GOG.com/Galaxy');
      const hostGogStorageDir = path.join(hostGogDir, 'storage');
      fs.mkdirSync(hostGogStorageDir, { recursive: true });
      fs.writeFileSync(
        path.join(hostGogDir, 'config.json'),
        JSON.stringify({ userId: SYNTHETIC_GOG_USER_ID_PRIMARY }),
        'utf8'
      );
      const hostGogDbPath = path.join(hostGogStorageDir, 'galaxy-2.0.db');
      const gogDb = new DatabaseSync(hostGogDbPath);
      gogDb.exec('CREATE TABLE Users (id INTEGER PRIMARY KEY, username TEXT);');
      gogDb
        .prepare('INSERT INTO Users (id, username) VALUES (?, ?)')
        .run(Number(SYNTHETIC_GOG_USER_ID_PRIMARY), 'SyntheticGog42');
      gogDb.close();

      const bottleGogDir = path.join(bottlePath, 'drive_c/ProgramData/GOG.com/Galaxy');
      fs.mkdirSync(bottleGogDir, { recursive: true });
      fs.writeFileSync(
        path.join(bottleGogDir, 'config.json'),
        JSON.stringify({ userId: SYNTHETIC_GOG_USER_ID_MISMATCH }),
        'utf8'
      );

      // 3) Host Epic = matching base64 [RememberMe]; Bottled Epic = mismatched AccountId
      const makeEpicIni = (accountId: string, displayName: string) => {
        const b64 = Buffer.from(
          JSON.stringify([
            {
              Region: 'Prod',
              AccountId: accountId,
              DisplayName: displayName,
              Token: 'synthetic_session_secret_do_not_expose',
            },
          ]),
          'utf8'
        ).toString('base64');
        return `[RememberMe]\nEnable=True\nData=${b64}\n`;
      };

      const hostEpicIni = path.join(
        homedir,
        'Library/Application Support/Epic/EpicGamesLauncher/Saved/Config/Mac/GameUserSettings.ini'
      );
      fs.mkdirSync(path.dirname(hostEpicIni), { recursive: true });
      fs.writeFileSync(
        hostEpicIni,
        makeEpicIni(SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY, 'EpicHero42'),
        'utf8'
      );

      const bottleEpicIni = path.join(
        bottlePath,
        'drive_c/users/crossover/AppData/Local/EpicGamesLauncher/Saved/Config/Windows/GameUserSettings.ini'
      );
      fs.mkdirSync(path.dirname(bottleEpicIni), { recursive: true });
      fs.writeFileSync(
        bottleEpicIni,
        makeEpicIni(SYNTHETIC_EPIC_ACCOUNT_ID_MISMATCH, 'EpicOther99'),
        'utf8'
      );

      const snapshot: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: true,
          connectedStorefronts: ['steam', 'gog', 'epic'],
          savedTokens: {
            steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY },
            gog: { access_token: 'gog_tok_valid_42', user_id: SYNTHETIC_GOG_USER_ID_PRIMARY },
            epic: {
              access_token: 'epic_tok_valid_42',
              account_id: SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY,
            },
          },
        });

      const { clientLogins } = snapshot;

      // Host clients match One Launcher accounts
      expect(clientLogins.host_steam.authenticated).toBe(true);
      expect(clientLogins.host_steam.autoLoginEnabled).toBe(true);
      expect(clientLogins.host_steam.detectedAccountLabel).toBe('TestPlayer42');
      expect(clientLogins.host_steam.accountMatchesOneLauncher).toBe(true);
      expect(clientLogins.host_steam.mismatchReason).toBeUndefined();

      expect(clientLogins.host_gog.authenticated).toBe(true);
      expect(clientLogins.host_gog.detectedAccountLabel).toBe('SyntheticGog42');
      expect(clientLogins.host_gog.accountMatchesOneLauncher).toBe(true);

      expect(clientLogins.host_epic.authenticated).toBe(true);
      expect(clientLogins.host_epic.detectedAccountLabel).toBe('EpicHero42');
      expect(clientLogins.host_epic.accountMatchesOneLauncher).toBe(true);
      // Never leak raw Epic session token into probe output
      expect(JSON.stringify(clientLogins.host_epic)).not.toContain(
        'synthetic_session_secret_do_not_expose'
      );

      // Bottled clients accurately report accountMatchesOneLauncher: false + mismatchReason
      expect(clientLogins.bottle_steam.authenticated).toBe(true);
      expect(clientLogins.bottle_steam.accountMatchesOneLauncher).toBe(false);
      expect(clientLogins.bottle_steam.mismatchReason).toContain('OtherPlayer99');
      expect(clientLogins.bottle_steam.mismatchReason).toContain(SYNTHETIC_STEAM_ID_PRIMARY);

      expect(clientLogins.bottle_gog.authenticated).toBe(true);
      expect(clientLogins.bottle_gog.accountMatchesOneLauncher).toBe(false);
      expect(clientLogins.bottle_gog.mismatchReason).toContain(SYNTHETIC_GOG_USER_ID_MISMATCH);

      expect(clientLogins.bottle_epic.authenticated).toBe(true);
      expect(clientLogins.bottle_epic.accountMatchesOneLauncher).toBe(false);
      expect(clientLogins.bottle_epic.mismatchReason).toContain('EpicOther99');

      expect(snapshot.counts.accountMismatchCount).toBe(3);

      // Explicit GOG sign-out (userId: "") overrides cached Users row in galaxy-2.0.db
      fs.writeFileSync(path.join(hostGogDir, 'config.json'), JSON.stringify({ userId: '' }), 'utf8');
      const postSignOutLogins = await environmentHealthProber.probeClientLoginStates({
        platform: 'darwin',
        homedir,
        userDataDir,
        connectedStorefronts: ['gog'],
        savedTokens: { gog: { access_token: 'gog_tok_valid_42', user_id: SYNTHETIC_GOG_USER_ID_PRIMARY } },
      });
      expect(postSignOutLogins.host_gog.authenticated).toBe(false);
    });

    it('4.2 launches unauthenticated bottled Steam interactively (without -silent), detects loginusers.vdf transition, and auto-closes cleanly', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('guided-login');
      seedMockCrossOverApp(path.join(homedir, 'Applications'), '26.0.0');
      const bottlePath = seedInitializedCrossOverBottle(homedir, 'OneLauncher', {
        withSteam: true,
      });
      const vdfPath = path.join(bottlePath, 'drive_c/Program Files (x86)/Steam/config/loginusers.vdf');
      fs.mkdirSync(path.dirname(vdfPath), { recursive: true });
      // Initially empty / signed-out loginusers.vdf
      fs.writeFileSync(vdfPath, '"users"\n{\n}\n', 'utf8');

      const spawnArgsCaptured: Array<{ bin: string; args: string[]; env: Record<string, any> }> = [];
      const closeCallsCaptured: Array<{ cmd: string; args: string[] }> = [];

      const loginResult = await environmentProvisioner.startGuidedClientLogin(
        {
          targetId: 'bottle_steam',
          runnerType: 'crossover',
          bottleName: 'OneLauncher',
          autoCloseOnSuccess: true,
          timeoutMs: 3000,
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          pollIntervalMs: 25,
          postLoginFlushDelayMs: 10,
          connectedStorefronts: ['steam'],
          savedTokens: { steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY } },
          spawnFn: (bin: string, args: string[], opts: any) => {
            spawnArgsCaptured.push({ bin, args, env: opts?.env || {} });
            // Simulate user completing interactive Steam login 30ms after window opens
            setTimeout(() => {
              fs.writeFileSync(
                vdfPath,
                buildSteamLoginUsersVdf([
                  {
                    steamId64: SYNTHETIC_STEAM_ID_PRIMARY,
                    accountName: 'testplayer42',
                    personaName: 'TestPlayer42',
                    mostRecent: true,
                    allowAutoLogin: true,
                  },
                ]),
                'utf8'
              );
            }, 30);
            return { unref: vi.fn() };
          },
          execFileFn: (cmd: string, args: string[], _opts: any, cb: Function) => {
            closeCallsCaptured.push({ cmd, args });
            cb(null, '', '');
            return {};
          },
        }
      );

      expect(spawnArgsCaptured).toHaveLength(1);
      // Interactive foreground launch MUST NOT pass -silent or -nochatui
      expect(spawnArgsCaptured[0].args.some((a) => a.includes('-silent'))).toBe(false);
      expect(spawnArgsCaptured[0].env.CX_BOTTLE).toBe('OneLauncher');
      expect(spawnArgsCaptured[0].env.WINEPREFIX).toBe(bottlePath);

      expect(loginResult.success).toBe(true);
      expect(loginResult.authenticated).toBe(true);
      expect(loginResult.autoClosedClient).toBe(true);
      expect(loginResult.probeState.accountMatchesOneLauncher).toBe(true);
      expect(loginResult.probeState.detectedAccountLabel).toBe('TestPlayer42');
      // Verify graceful Steam `-shutdown` was issued to close foreground window
      expect(closeCallsCaptured.some((c) => c.args.includes('-shutdown'))).toBe(true);

      // Verify cancelGuidedClientLogin aborts an in-flight watcher deterministically
      fs.writeFileSync(vdfPath, '"users"\n{\n}\n', 'utf8');
      const pendingPromise = environmentProvisioner.startGuidedClientLogin(
        {
          targetId: 'bottle_steam',
          runnerType: 'crossover',
          bottleName: 'OneLauncher',
          timeoutMs: 10000,
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          pollIntervalMs: 40,
          spawnClientFn: async () => {
            setTimeout(() => {
              environmentProvisioner.cancelGuidedClientLogin('bottle_steam');
            }, 20);
          },
        }
      );
      const cancelledRes = await pendingPromise;
      expect(cancelledRes.success).toBe(false);
      expect(cancelledRes.cancelled).toBe(true);
    });

    it('4.3 detects UE5 Epic MacEditor/WindowsEditor encrypted [RememberMe] sessions, disambiguates multi-account Saved/Data/*.dat mtimes, falls back to legendary user.json, and populates localStoreHints', async () => {
      // A) macOS Native Epic (MacEditor/GameUserSettings.ini + opaque AES-encrypted [RememberMe])
      const macEnv = makeIsolatedEnv('epic-ue5-mac');
      fs.mkdirSync(path.join(macEnv.homedir, 'Applications/Epic Games Launcher.app'), {
        recursive: true,
      });

      const opaqueEncryptedBlobB64 = Buffer.from(
        Uint8Array.from([
          0xde, 0xad, 0xbe, 0xef, 0x91, 0xa4, 0x5c, 0x11, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
          0xee, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80,
        ])
      ).toString('base64');

      const macEditorIniPath = path.join(
        macEnv.homedir,
        'Library/Application Support/Epic/EpicGamesLauncher/Saved/Config/MacEditor/GameUserSettings.ini'
      );
      fs.mkdirSync(path.dirname(macEditorIniPath), { recursive: true });
      fs.writeFileSync(
        macEditorIniPath,
        [
          '[RememberMe]',
          'Enable=True',
          `Data=${opaqueEncryptedBlobB64}`,
          '',
          `[${SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY}_General]`,
          'LastTab=Library',
          '',
        ].join('\n'),
        'utf8'
      );

      const macStates = await environmentHealthProber.probeClientLoginStates({
        platform: 'darwin',
        homedir: macEnv.homedir,
        userDataDir: macEnv.userDataDir,
        connectedStorefronts: ['epic'],
        savedTokens: {
          epic: {
            account_id: SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY,
            displayName: 'SyntheticHero',
          },
        },
      });

      expect(macStates.host_epic.installed).toBe(true);
      expect(macStates.host_epic.authenticated).toBe(true);
      expect(macStates.host_epic.accountMatchesOneLauncher).toBe(true);
      expect(macStates.host_epic.detectedAccountLabel).toBe('SyntheticHero');
      expect(macStates.host_epic.detectedAccountLabel).not.toMatch(/^[a-f0-9]{32}$/i);

      // Fresh install where 'epic' is NOT connected -> UE5 MacEditor session produces 'epic' localStoreHint
      const freshUnconnectedSnapshot: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir: macEnv.homedir,
          userDataDir: macEnv.userDataDir,
          rosettaInstalled: true,
          connectedStorefronts: [],
          savedTokens: {},
        });
      const epicHint = freshUnconnectedSnapshot.localStoreHints.find(
        (h) => h.storefrontId === 'epic'
      );
      expect(epicHint).toBeDefined();
      expect(epicHint?.hasReusableSession).toBe(false);
      expect(epicHint?.sourceLabel).toBe('Epic Games Launcher (Mac)');
      // Must never expose raw 32-hex account UUID as a public handle hint
      expect(epicHint?.publicHandleHint || '').not.toMatch(/^[a-f0-9]{32}$/i);

      // B) macOS Bottle & Windows Host UE5 WindowsEditor/GameUserSettings.ini + multi-account .dat mtimeMs + legendary user.json fallback
      const multiEnv = makeIsolatedEnv('epic-ue5-multi');
      seedMockCrossOverApp(path.join(multiEnv.homedir, 'Applications'), '26.0.0');
      const bottlePath = seedInitializedCrossOverBottle(multiEnv.homedir, 'OneLauncher', {
        withEpicLauncher: true,
      });

      // Seed legendaryConfig/legendary/user.json while omitting account_id from savedTokens.epic
      const legUserJson = path.join(
        multiEnv.userDataDir,
        'legendaryConfig/legendary/user.json'
      );
      fs.mkdirSync(path.dirname(legUserJson), { recursive: true });
      fs.writeFileSync(
        legUserJson,
        JSON.stringify({
          account_id: SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY,
          displayName: 'SyntheticHero',
        }),
        'utf8'
      );

      const multiAccountIniContent = [
        '[RememberMe]',
        'Enable=True',
        `Data=${opaqueEncryptedBlobB64}`,
        '',
        `[${SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY}_General]`,
        'LastTab=Store',
        '',
        `[${SYNTHETIC_EPIC_ACCOUNT_ID_MISMATCH}_General]`,
        'LastTab=Library',
        '',
      ].join('\r\n');

      // Seed inside macOS bottle
      const bottleWinEditorIni = path.join(
        bottlePath,
        'drive_c/users/crossover/AppData/Local/EpicGamesLauncher/Saved/Config/WindowsEditor/GameUserSettings.ini'
      );
      const bottleDataDir = path.join(
        bottlePath,
        'drive_c/users/crossover/AppData/Local/EpicGamesLauncher/Saved/Data'
      );
      fs.mkdirSync(path.dirname(bottleWinEditorIni), { recursive: true });
      fs.mkdirSync(bottleDataDir, { recursive: true });
      fs.writeFileSync(bottleWinEditorIni, multiAccountIniContent, 'utf8');

      const bottleDat42 = path.join(bottleDataDir, `${SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY}.dat`);
      const bottleDat99 = path.join(bottleDataDir, `${SYNTHETIC_EPIC_ACCOUNT_ID_MISMATCH}.dat`);
      fs.writeFileSync(bottleDat42, 'SYNTHETIC-DAT-42', 'utf8');
      fs.writeFileSync(bottleDat99, 'SYNTHETIC-DAT-99', 'utf8');

      // Also seed Windows native host layout
      const winHostExe = path.join(
        multiEnv.homedir,
        'Program Files (x86)/Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe'
      );
      fs.mkdirSync(path.dirname(winHostExe), { recursive: true });
      fs.writeFileSync(winHostExe, 'MZ-SYNTHETIC-EPIC', 'utf8');
      const winEditorIni = path.join(
        multiEnv.homedir,
        'AppData/Local/EpicGamesLauncher/Saved/Config/WindowsEditor/GameUserSettings.ini'
      );
      const winDataDir = path.join(
        multiEnv.homedir,
        'AppData/Local/EpicGamesLauncher/Saved/Data'
      );
      fs.mkdirSync(path.dirname(winEditorIni), { recursive: true });
      fs.mkdirSync(winDataDir, { recursive: true });
      fs.writeFileSync(winEditorIni, multiAccountIniContent, 'utf8');

      const winDat42 = path.join(winDataDir, `${SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY}.dat`);
      const winDat99 = path.join(winDataDir, `${SYNTHETIC_EPIC_ACCOUNT_ID_MISMATCH}.dat`);
      fs.writeFileSync(winDat42, 'SYNTHETIC-DAT-42', 'utf8');
      fs.writeFileSync(winDat99, 'SYNTHETIC-DAT-99', 'utf8');

      // Case 1: ...99.dat is newer than ...42.dat -> selects ...99 -> accountMatchesOneLauncher: false
      const olderTime = new Date('2026-10-01T00:00:00.000Z');
      const newerTime = new Date('2026-10-02T00:00:00.000Z');
      fs.utimesSync(bottleDat42, olderTime, olderTime);
      fs.utimesSync(bottleDat99, newerTime, newerTime);
      fs.utimesSync(winDat42, olderTime, olderTime);
      fs.utimesSync(winDat99, newerTime, newerTime);

      const bottleMismatchStates = await environmentHealthProber.probeClientLoginStates({
        platform: 'darwin',
        homedir: multiEnv.homedir,
        userDataDir: multiEnv.userDataDir,
        connectedStorefronts: ['epic'],
        savedTokens: { epic: { access_token: 'epic_tok_without_account_id' } },
      });
      expect(bottleMismatchStates.bottle_epic.installed).toBe(true);
      expect(bottleMismatchStates.bottle_epic.authenticated).toBe(true);
      expect(bottleMismatchStates.bottle_epic.accountMatchesOneLauncher).toBe(false);
      expect(bottleMismatchStates.bottle_epic.mismatchReason).toContain('SyntheticHero');
      expect(bottleMismatchStates.bottle_epic.detectedAccountLabel).toBeUndefined();

      const winMismatchStates = await environmentHealthProber.probeClientLoginStates({
        platform: 'win32',
        homedir: multiEnv.homedir,
        userDataDir: multiEnv.userDataDir,
        connectedStorefronts: ['epic'],
        savedTokens: { epic: { access_token: 'epic_tok_without_account_id' } },
      });
      expect(winMismatchStates.host_epic.installed).toBe(true);
      expect(winMismatchStates.host_epic.authenticated).toBe(true);
      expect(winMismatchStates.host_epic.accountMatchesOneLauncher).toBe(false);
      expect(winMismatchStates.host_epic.mismatchReason).toContain('SyntheticHero');

      // Case 2: ...42.dat has newer mtimeMs -> selects ...42 -> accountMatchesOneLauncher: true + 'SyntheticHero'
      const newestTime = new Date('2026-10-03T00:00:00.000Z');
      fs.utimesSync(bottleDat42, newestTime, newestTime);
      fs.utimesSync(winDat42, newestTime, newestTime);

      const bottleMatchStates = await environmentHealthProber.probeClientLoginStates({
        platform: 'darwin',
        homedir: multiEnv.homedir,
        userDataDir: multiEnv.userDataDir,
        connectedStorefronts: ['epic'],
        savedTokens: { epic: { access_token: 'epic_tok_without_account_id' } },
      });
      expect(bottleMatchStates.bottle_epic.authenticated).toBe(true);
      expect(bottleMatchStates.bottle_epic.accountMatchesOneLauncher).toBe(true);
      expect(bottleMatchStates.bottle_epic.detectedAccountLabel).toBe('SyntheticHero');

      const winMatchStates = await environmentHealthProber.probeClientLoginStates({
        platform: 'win32',
        homedir: multiEnv.homedir,
        userDataDir: multiEnv.userDataDir,
        connectedStorefronts: ['epic'],
        savedTokens: { epic: { access_token: 'epic_tok_without_account_id' } },
      });
      expect(winMatchStates.host_epic.authenticated).toBe(true);
      expect(winMatchStates.host_epic.accountMatchesOneLauncher).toBe(true);
      expect(winMatchStates.host_epic.detectedAccountLabel).toBe('SyntheticHero');

      // Case 3: macOS Unreal Engine Preferences INI path + Application Support Saved/Data/*.dat disambiguation
      const macPrefsEnv = makeIsolatedEnv('epic-mac-prefs-multi');
      const macPrefsAppExe = path.join(
        macPrefsEnv.homedir,
        'Applications/Epic Games Launcher.app/Contents/MacOS/EpicGamesLauncher-Mac-Shipping'
      );
      fs.mkdirSync(path.dirname(macPrefsAppExe), { recursive: true });
      fs.writeFileSync(macPrefsAppExe, '#!/bin/sh\nexit 0\n', 'utf8');
      const macPrefsIni = path.join(
        macPrefsEnv.homedir,
        'Library/Preferences/Unreal Engine/EpicGamesLauncher/MacEditor/GameUserSettings.ini'
      );
      const macAppSupportDataDir = path.join(
        macPrefsEnv.homedir,
        'Library/Application Support/Epic/EpicGamesLauncher/Saved/Data'
      );
      fs.mkdirSync(path.dirname(macPrefsIni), { recursive: true });
      fs.mkdirSync(macAppSupportDataDir, { recursive: true });
      fs.writeFileSync(macPrefsIni, multiAccountIniContent, 'utf8');
      const macDat42 = path.join(macAppSupportDataDir, `${SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY}.dat`);
      const macDat99 = path.join(macAppSupportDataDir, `${SYNTHETIC_EPIC_ACCOUNT_ID_MISMATCH}.dat`);
      fs.writeFileSync(macDat42, 'SYNTHETIC-DAT-42', 'utf8');
      fs.writeFileSync(macDat99, 'SYNTHETIC-DAT-99', 'utf8');
      fs.utimesSync(macDat42, olderTime, olderTime);
      fs.utimesSync(macDat99, newerTime, newerTime);

      const macPrefsMismatch = await environmentHealthProber.probeClientLoginStates({
        platform: 'darwin',
        homedir: macPrefsEnv.homedir,
        userDataDir: macPrefsEnv.userDataDir,
        connectedStorefronts: ['epic'],
        savedTokens: {
          epic: { account_id: SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY, displayName: 'SyntheticHero' },
        },
      });
      expect(macPrefsMismatch.host_epic.authenticated).toBe(true);
      expect(macPrefsMismatch.host_epic.accountMatchesOneLauncher).toBe(false);
    });

    it('4.4 auto-retriggers steam://install/<appId> in unsigned bottled Steam upon manual sign-in and supports forceInteractiveLogin foreground verification', async () => {
      // Part A: Bottled Steam Deferred Install Auto-Trigger
      const { homedir, userDataDir } = makeIsolatedEnv('steam-deferred-autotrigger');
      seedMockCrossOverApp(path.join(homedir, 'Applications'), '26.0.0');
      const bottlePath = seedInitializedCrossOverBottle(homedir, 'OneLauncher', {
        withSteam: true,
      });

      const bottleSteamRoot = path.join(bottlePath, 'drive_c/Program Files (x86)/Steam');
      const vdfPath = path.join(bottleSteamRoot, 'config/loginusers.vdf');
      fs.mkdirSync(path.dirname(vdfPath), { recursive: true });
      // Logged-out session initially (MostRecent "0", AllowAutoLogin "0")
      fs.writeFileSync(
        vdfPath,
        buildSteamLoginUsersVdf([
          {
            steamId64: SYNTHETIC_STEAM_ID_PRIMARY,
            accountName: 'testplayer42',
            personaName: 'TestPlayer42',
            mostRecent: false,
            allowAutoLogin: false,
          },
        ]),
        'utf8'
      );

      const spawnCalls: Array<{ bin: string; args: string[]; env: Record<string, any> }> = [];
      const spawnFn = (bin: string, args: string[], opts: any) => {
        spawnCalls.push({ bin, args, env: opts?.env || {} });
        return { unref: vi.fn() };
      };

      const installRes = await launcherEngine.installGame(
        {
          gameId: 'steam-42000',
          title: 'Synthetic Quest',
          platformId: 'steam',
          platformGameId: '42000',
          steamAppId: 42000,
          installDir: path.join(homedir, 'Games'),
          installerId: 'steam-win-compat',
          os: 'windows',
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          spawnFn,
          steamPollIntervalMs: 15,
          steamPostLoginRetriggerDelayMs: 20,
          steamPostLoginSecondRetryMs: 120,
        }
      );

      expect(installRes.success).toBe(true);
      const taskId = installRes.task.id;

      try {
        expect(spawnCalls).toHaveLength(1);
        expect(spawnCalls[0].args[0]).toMatch(/steam\.exe$/i);
        expect(spawnCalls[0].args[1]).toBe('steam://install/42000');
        expect(installRes.task.statusMessage).toContain(
          'Installing via Windows Steam in CrossOver / Wine'
        );
        expect(installRes.task.statusMessage).toContain('waiting for Steam sign-in');

        // Wait 45ms while still unsigned -> must NOT retrigger prematurely
        await new Promise((r) => setTimeout(r, 45));
        expect(spawnCalls).toHaveLength(1);

        // Simulate user completing interactive Steam login inside bottle
        fs.writeFileSync(
          vdfPath,
          buildSteamLoginUsersVdf([
            {
              steamId64: SYNTHETIC_STEAM_ID_PRIMARY,
              accountName: 'testplayer42',
              personaName: 'TestPlayer42',
              mostRecent: true,
              allowAutoLogin: true,
            },
          ]),
          'utf8'
        );

        // Wait (<200ms) for monitor to detect sign-in and automatically re-dispatch steam://install/42000
        const retriggerDeadline = Date.now() + 200;
        while (spawnCalls.length < 2 && Date.now() < retriggerDeadline) {
          await new Promise((r) => setTimeout(r, 10));
        }

        expect(spawnCalls).toHaveLength(2);
        expect(spawnCalls[1].args[0]).toMatch(/steam\.exe$/i);
        expect(spawnCalls[1].args[1]).toBe('steam://install/42000');

        const activeQueue = launcherEngine.getDownloadQueue({ userDataDir });
        const retriggeredTask = activeQueue.find((t: any) => t.id === taskId);
        expect(retriggeredTask).toBeDefined();
        expect(retriggeredTask.statusMessage).toBe(
          'Steam sign-in detected in bottle — triggering game download...'
        );

        // Write appmanifest_42000.acf + executable inside bottle -> task reaches 'completed'
        const steamappsDir = path.join(bottleSteamRoot, 'steamapps');
        const commonGameDir = path.join(steamappsDir, 'common/Synthetic Quest');
        fs.mkdirSync(commonGameDir, { recursive: true });
        fs.writeFileSync(
          path.join(commonGameDir, 'SyntheticQuest.exe'),
          buildSyntheticInstallerPe64Buffer({ totalBytes: 4096, withAuthenticode: false })
        );
        fs.writeFileSync(
          path.join(steamappsDir, 'appmanifest_42000.acf'),
          [
            '"AppState"',
            '{',
            '\t"appid"\t\t"42000"',
            '\t"Universe"\t\t"1"',
            '\t"name"\t\t"Synthetic Quest"',
            '\t"StateFlags"\t\t"4"',
            '\t"installdir"\t\t"Synthetic Quest"',
            '\t"SizeOnDisk"\t\t"1048576"',
            '\t"BytesToDownload"\t\t"1048576"',
            '\t"BytesDownloaded"\t\t"1048576"',
            '}',
            '',
          ].join('\n'),
          'utf8'
        );

        let completedTask: any = null;
        const completeDeadline = Date.now() + 200;
        while (Date.now() < completeDeadline) {
          const cur = launcherEngine
            .getDownloadQueue({ userDataDir })
            .find((t: any) => t.id === taskId);
          if (cur?.status === 'completed') {
            completedTask = cur;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }

        expect(completedTask).not.toBeNull();
        expect(completedTask.status).toBe('completed');
        expect(completedTask.executablePath).toMatch(/SyntheticQuest\.exe$/);
      } finally {
        launcherEngine.cancelDownload(taskId, { userDataDir });
      }

      // Part B: forceInteractiveLogin IPC sanitization & foreground re-open without auto-close
      const sanitizedTrue = launcherIpcHandlers.sanitizeGuidedClientLoginPayload({
        targetId: 'bottle_steam',
        bottleName: 'OneLauncher',
        forceInteractiveLogin: true,
      });
      expect(sanitizedTrue.ok).toBe(true);
      expect(sanitizedTrue.payload.forceInteractiveLogin).toBe(true);

      const sanitizedNonBool = launcherIpcHandlers.sanitizeGuidedClientLoginPayload({
        targetId: 'bottle_steam',
        bottleName: 'OneLauncher',
        forceInteractiveLogin: 'true',
      });
      expect(sanitizedNonBool.ok).toBe(true);
      expect(sanitizedNonBool.payload.forceInteractiveLogin).toBeUndefined();

      const spawnClientFn = vi.fn(async () => {});
      const closeClientFn = vi.fn(async () => {});
      const fgVerifyResult = await environmentProvisioner.startGuidedClientLogin(
        {
          targetId: 'bottle_steam',
          bottleName: 'OneLauncher',
          forceInteractiveLogin: true,
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          connectedStorefronts: ['steam'],
          savedTokens: { steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY } },
          spawnClientFn,
          closeClientFn,
        }
      );

      expect(spawnClientFn).toHaveBeenCalledTimes(1);
      expect(fgVerifyResult.success).toBe(true);
      expect(fgVerifyResult.authenticated).toBe(true);
      expect(fgVerifyResult.autoClosedClient).toBe(false);
      expect(closeClientFn).not.toHaveBeenCalled();

      // Part C: Account-mismatch retrigger (Steam starts signed into wrong account -> user switches to expected SteamID64 -> auto-retriggers)
      const mismatchEnv = makeIsolatedEnv('steam-mismatch-autotrigger');
      seedMockCrossOverApp(path.join(mismatchEnv.homedir, 'Applications'), '26.0.0');
      const mismatchBottlePath = seedInitializedCrossOverBottle(
        mismatchEnv.homedir,
        'OneLauncher',
        { withSteam: true }
      );
      fs.writeFileSync(
        path.join(mismatchEnv.userDataDir, 'tokens.json'),
        JSON.stringify({ steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY } }),
        'utf8'
      );
      const mismatchVdfPath = path.join(
        mismatchBottlePath,
        'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'
      );
      fs.mkdirSync(path.dirname(mismatchVdfPath), { recursive: true });
      fs.writeFileSync(
        mismatchVdfPath,
        buildSteamLoginUsersVdf([
          {
            steamId64: SYNTHETIC_STEAM_ID_MISMATCH,
            accountName: 'wrongaccount99',
            personaName: 'WrongAccount99',
            mostRecent: true,
            allowAutoLogin: true,
          },
        ]),
        'utf8'
      );

      const mismatchSpawnCalls: Array<{ bin: string; args: string[] }> = [];
      const mismatchInstallRes = await launcherEngine.installGame(
        {
          gameId: 'steam-42001',
          title: 'Synthetic Mismatch Quest',
          platformId: 'steam',
          platformGameId: '42001',
          steamAppId: 42001,
          installDir: path.join(mismatchEnv.homedir, 'Games'),
          installerId: 'steam-win-compat',
          os: 'windows',
        },
        {
          platform: 'darwin',
          homedir: mismatchEnv.homedir,
          userDataDir: mismatchEnv.userDataDir,
          spawnFn: (bin: string, args: string[]) => {
            mismatchSpawnCalls.push({ bin, args });
            return { unref: vi.fn() };
          },
          steamPollIntervalMs: 15,
          steamPostLoginRetriggerDelayMs: 20,
          steamPostLoginSecondRetryMs: 120,
        }
      );

      expect(mismatchInstallRes.success).toBe(true);
      const mismatchTaskId = mismatchInstallRes.task.id;
      try {
        expect(mismatchSpawnCalls).toHaveLength(1);
        expect(mismatchInstallRes.task.statusMessage).toContain('waiting for Steam sign-in');

        // Still on wrong account -> must NOT retrigger
        await new Promise((r) => setTimeout(r, 45));
        expect(mismatchSpawnCalls).toHaveLength(1);

        // User switches Steam to One Launcher's connected SYNTHETIC_STEAM_ID_PRIMARY -> auto-retriggers!
        fs.writeFileSync(
          mismatchVdfPath,
          buildSteamLoginUsersVdf([
            {
              steamId64: SYNTHETIC_STEAM_ID_PRIMARY,
              accountName: 'testplayer42',
              personaName: 'TestPlayer42',
              mostRecent: true,
              allowAutoLogin: true,
            },
          ]),
          'utf8'
        );

        const mismatchDeadline = Date.now() + 200;
        while (mismatchSpawnCalls.length < 2 && Date.now() < mismatchDeadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(mismatchSpawnCalls).toHaveLength(2);
        expect(mismatchSpawnCalls[1].args[1]).toBe('steam://install/42001');
      } finally {
        launcherEngine.cancelDownload(mismatchTaskId, { userDataDir: mismatchEnv.userDataDir });
      }

      // Part D: Cancelling guided login during postLoginFlushDelayMs wakes immediately and skips auto-close
      const flushCancelEnv = makeIsolatedEnv('guided-flush-cancel');
      seedMockCrossOverApp(path.join(flushCancelEnv.homedir, 'Applications'), '26.0.0');
      const flushBottlePath = seedInitializedCrossOverBottle(
        flushCancelEnv.homedir,
        'OneLauncher',
        { withSteam: true }
      );
      const flushVdfPath = path.join(
        flushBottlePath,
        'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'
      );
      fs.mkdirSync(path.dirname(flushVdfPath), { recursive: true });
      fs.writeFileSync(flushVdfPath, '"users"\n{\n}\n', 'utf8');

      const flushCloseSpy = vi.fn(async () => {});
      const flushGuidedPromise = environmentProvisioner.startGuidedClientLogin(
        {
          targetId: 'bottle_steam',
          bottleName: 'OneLauncher',
          autoCloseOnSuccess: true,
        },
        {
          platform: 'darwin',
          homedir: flushCancelEnv.homedir,
          userDataDir: flushCancelEnv.userDataDir,
          connectedStorefronts: ['steam'],
          savedTokens: { steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY } },
          pollIntervalMs: 15,
          postLoginFlushDelayMs: 5000,
          spawnClientFn: async () => {
            setTimeout(() => {
              fs.writeFileSync(
                flushVdfPath,
                buildSteamLoginUsersVdf([
                  {
                    steamId64: SYNTHETIC_STEAM_ID_PRIMARY,
                    accountName: 'testplayer42',
                    personaName: 'TestPlayer42',
                    mostRecent: true,
                    allowAutoLogin: true,
                  },
                ]),
                'utf8'
              );
            }, 10);
          },
          closeClientFn: flushCloseSpy,
        }
      );

      // Wait until guided_login_detected enters the 5000ms flush delay, then cancel immediately
      await new Promise((r) => setTimeout(r, 45));
      const cancelDuringFlushStart = Date.now();
      environmentProvisioner.cancelGuidedClientLogin('bottle_steam');
      const flushCancelledRes = await flushGuidedPromise;
      expect(Date.now() - cancelDuringFlushStart).toBeLessThan(500);
      expect(flushCancelledRes.cancelled).toBe(true);
      expect(flushCancelledRes.authenticated).toBe(false);
      expect(flushCloseSpy).not.toHaveBeenCalled();
    });

    it('4.5 recognizes bottled & win32 GOG Galaxy 2.0/2.1 Configuration/config.json + user.reg + 17-digit INT64 Users(id) schema and exits tray-minimized Galaxy cleanly', async () => {
      const SYNTHETIC_GOG_INT64_PRIMARY = '50000000000000042'; // > Number.MAX_SAFE_INTEGER
      const SYNTHETIC_GOG_INT64_MISMATCH = '50000000000000099';

      // Part A: CrossOver bottle with real GOG Galaxy 2.1 split config + Users(id INT64) schema + tray shutdown
      const { homedir, userDataDir } = makeIsolatedEnv('gog-bottle-21');
      const cxAppPath = seedMockCrossOverApp(path.join(homedir, 'Applications'), '26.0.0');
      fs.writeFileSync(
        path.join(cxAppPath, 'Contents/SharedSupport/CrossOver/bin/wineserver'),
        '#!/bin/sh\nexit 0\n',
        { mode: 0o755 }
      );
      const bottlePath = seedInitializedCrossOverBottle(homedir, 'OneLauncher', {
        withGogGalaxy: true,
      });

      // System-wide ProgramData config.json has NO userId (real GOG Galaxy 2.0/2.1 layout)
      const progDataGogDir = path.join(bottlePath, 'drive_c/ProgramData/GOG.com/Galaxy');
      const progDataStorageDir = path.join(progDataGogDir, 'storage');
      fs.mkdirSync(progDataStorageDir, { recursive: true });
      fs.writeFileSync(
        path.join(progDataGogDir, 'config.json'),
        JSON.stringify({
          clientInstanceId: '00000000-0000-4000-8000-000000000042',
          libraryPath: 'C:\\Program Files (x86)\\GOG Galaxy\\Games',
          storagePath: 'C:\\ProgramData\\GOG.com\\Galaxy\\storage',
        }),
        'utf8'
      );

      // Real GOG Galaxy 2.0/2.1 SQLite schema: Users('id' INT64 NOT NULL PRIMARY KEY) WITHOUT username column
      const bottleDbPath = path.join(progDataStorageDir, 'galaxy-2.0.db');
      const bottleDb = new DatabaseSync(bottleDbPath);
      bottleDb.exec("CREATE TABLE Users ('id' INT64 NOT NULL PRIMARY KEY);");
      bottleDb
        .prepare('INSERT INTO Users (id) VALUES (?)')
        .run(BigInt(SYNTHETIC_GOG_INT64_PRIMARY));
      bottleDb.close();

      // Per-user AppData/Local Configuration/config.json starts open & unsigned (minimizeToTray, no userId)
      const bottleUserCfgPath = path.join(
        bottlePath,
        'drive_c/users/crossover/AppData/Local/GOG.com/Galaxy/Configuration/config.json'
      );
      fs.mkdirSync(path.dirname(bottleUserCfgPath), { recursive: true });
      fs.writeFileSync(
        bottleUserCfgPath,
        JSON.stringify({
          whenClosingMainWindow: 'minimizeToTray',
          language: 'en-US',
        }),
        'utf8'
      );

      // Pre-login probe MUST report authenticated: false despite historical Users(id) row in galaxy-2.0.db
      const preLoginStates = await environmentHealthProber.probeClientLoginStates({
        platform: 'darwin',
        homedir,
        userDataDir,
        connectedStorefronts: ['gog'],
        savedTokens: {
          gog: {
            access_token: 'gog_tok_valid_42',
            user_id: SYNTHETIC_GOG_INT64_PRIMARY,
            username: 'SyntheticGalaxy42',
          },
        },
      });
      expect(preLoginStates.bottle_gog.installed).toBe(true);
      expect(preLoginStates.bottle_gog.authenticated).toBe(false);

      const spawnCaptured: Array<{ bin: string; args: string[]; env: Record<string, any> }> = [];
      const closeCaptured: Array<{ cmd: string; args: string[]; env: Record<string, any> }> = [];

      const gogLoginResult = await environmentProvisioner.startGuidedClientLogin(
        {
          targetId: 'bottle_gog',
          runnerType: 'crossover',
          bottleName: 'OneLauncher',
          autoCloseOnSuccess: true,
          timeoutMs: 3000,
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          pollIntervalMs: 20,
          postLoginFlushDelayMs: 10,
          connectedStorefronts: ['gog'],
          savedTokens: {
            gog: {
              access_token: 'gog_tok_valid_42',
              user_id: SYNTHETIC_GOG_INT64_PRIMARY,
              username: 'SyntheticGalaxy42',
            },
          },
          spawnFn: (bin: string, args: string[], opts: any) => {
            spawnCaptured.push({ bin, args, env: opts?.env || {} });
            setTimeout(() => {
              fs.writeFileSync(
                bottleUserCfgPath,
                JSON.stringify({
                  userId: SYNTHETIC_GOG_INT64_PRIMARY,
                  username: 'SyntheticGalaxy42',
                  keepLoggedIn: true,
                  whenClosingMainWindow: 'minimizeToTray',
                }),
                'utf8'
              );
              fs.writeFileSync(
                path.join(bottlePath, 'user.reg'),
                [
                  'WINE REGISTRY Version 2',
                  '',
                  '[Software\\\\GOG.com\\\\Galaxy] 1730299000',
                  '"refreshToken"="synthetic_gog_refresh_secret_do_not_expose"',
                  '',
                  '[Software\\\\GOG.com\\\\Galaxy\\\\settings] 1730299001',
                  `"userId"="${SYNTHETIC_GOG_INT64_PRIMARY}"`,
                  '"username"="SyntheticGalaxy42"',
                  '',
                ].join('\n'),
                'utf8'
              );
            }, 25);
            return { unref: vi.fn() };
          },
          execFileFn: (cmd: string, args: string[], opts: any, cb: Function) => {
            const callback = typeof opts === 'function' ? opts : cb;
            const envObj = typeof opts === 'object' && opts ? opts.env || {} : {};
            closeCaptured.push({ cmd, args, env: envObj });
            if (typeof callback === 'function') callback(null, '', '');
            return {};
          },
        }
      );

      expect(spawnCaptured).toHaveLength(1);
      expect(spawnCaptured[0].args[0]).toMatch(/GalaxyClient\.exe$/i);
      expect(gogLoginResult.success).toBe(true);
      expect(gogLoginResult.authenticated).toBe(true);
      expect(gogLoginResult.autoClosedClient).toBe(true);
      expect(gogLoginResult.probeState.accountMatchesOneLauncher).toBe(true);
      expect(gogLoginResult.probeState.detectedAccountLabel).toBe('SyntheticGalaxy42');
      expect(JSON.stringify(gogLoginResult)).not.toContain(
        'synthetic_gog_refresh_secret_do_not_expose'
      );

      // Verify tray-safe shutdown sequence: /command=shutdown -> taskkill /F /T -> wineserver -k/-w
      expect(closeCaptured.some((c) => c.args.includes('/command=shutdown'))).toBe(true);
      expect(
        closeCaptured.some(
          (c) =>
            c.args[0] === 'taskkill' &&
            c.args.includes('/F') &&
            c.args.includes('/T') &&
            c.args.includes('GalaxyClient.exe')
        )
      ).toBe(true);
      expect(
        closeCaptured.some(
          (c) =>
            c.args[0] === 'taskkill' &&
            c.args.includes('/F') &&
            c.args.includes('GalaxyCommunication.exe')
        )
      ).toBe(true);
      expect(
        closeCaptured.some(
          (c) =>
            /wineserver$/i.test(c.cmd) &&
            c.args[0] === '-k' &&
            c.env.CX_BOTTLE === 'OneLauncher'
        )
      ).toBe(true);

      // Part B: Wine user.reg fallback + custom bottle user profile + INT64 DB precision + olGogUsername fallback
      fs.unlinkSync(bottleUserCfgPath);
      const regFallbackStates = await environmentHealthProber.probeClientLoginStates({
        platform: 'darwin',
        homedir,
        userDataDir,
        connectedStorefronts: ['gog'],
        savedTokens: {
          gog: {
            access_token: 'gog_tok_valid_42',
            user_id: SYNTHETIC_GOG_INT64_PRIMARY,
          },
        },
      });
      expect(regFallbackStates.bottle_gog.authenticated).toBe(true);
      expect(regFallbackStates.bottle_gog.accountMatchesOneLauncher).toBe(true);
      expect(regFallbackStates.bottle_gog.detectedAccountLabel).toBe('SyntheticGalaxy42');

      // Clear user.reg and test custom non-'crossover' user dir without username in config or DB -> resolves olGogUsername
      fs.writeFileSync(path.join(bottlePath, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
      const customUserCfgPath = path.join(
        bottlePath,
        'drive_c/users/portable_user/AppData/Local/GOG.com/Galaxy/Configuration/config.json'
      );
      fs.mkdirSync(path.dirname(customUserCfgPath), { recursive: true });
      fs.writeFileSync(
        customUserCfgPath,
        JSON.stringify({ userId: SYNTHETIC_GOG_INT64_PRIMARY }),
        'utf8'
      );
      const customUserMatch = await environmentHealthProber.probeClientLoginStates({
        platform: 'darwin',
        homedir,
        userDataDir,
        connectedStorefronts: ['gog'],
        savedTokens: {
          gog: {
            access_token: 'gog_tok_valid_42',
            user_id: SYNTHETIC_GOG_INT64_PRIMARY,
            username: 'SyntheticHandleFromVault',
          },
        },
      });
      expect(customUserMatch.bottle_gog.authenticated).toBe(true);
      expect(customUserMatch.bottle_gog.accountMatchesOneLauncher).toBe(true);
      expect(customUserMatch.bottle_gog.detectedAccountLabel).toBe('SyntheticHandleFromVault');

      // Mismatch on 17-digit INT64 differing only in final digits (catches any IEEE-754 float rounding)
      fs.writeFileSync(
        customUserCfgPath,
        JSON.stringify({ userId: SYNTHETIC_GOG_INT64_MISMATCH, username: 'SyntheticOther99' }),
        'utf8'
      );
      const customUserMismatch = await environmentHealthProber.probeClientLoginStates({
        platform: 'darwin',
        homedir,
        userDataDir,
        connectedStorefronts: ['gog'],
        savedTokens: {
          gog: {
            access_token: 'gog_tok_valid_42',
            user_id: SYNTHETIC_GOG_INT64_PRIMARY,
            username: 'SyntheticHandleFromVault',
          },
        },
      });
      expect(customUserMismatch.bottle_gog.authenticated).toBe(true);
      expect(customUserMismatch.bottle_gog.accountMatchesOneLauncher).toBe(false);
      expect(customUserMismatch.bottle_gog.mismatchReason).toContain('SyntheticOther99');

      // Part C: Windows (win32) host AppData/Local/GOG.com/Galaxy/Configuration/config.json + /command=shutdown parity
      const winEnv = makeIsolatedEnv('gog-win32-host');
      const winGogExe = path.join(winEnv.homedir, 'Program Files (x86)/GOG Galaxy/GalaxyClient.exe');
      fs.mkdirSync(path.dirname(winGogExe), { recursive: true });
      fs.writeFileSync(winGogExe, 'MZ-SYNTHETIC-WIN-GOG', 'utf8');
      const winLocalCfg = path.join(
        winEnv.homedir,
        'AppData/Local/GOG.com/Galaxy/Configuration/config.json'
      );
      fs.mkdirSync(path.dirname(winLocalCfg), { recursive: true });
      fs.writeFileSync(winLocalCfg, JSON.stringify({ whenClosingMainWindow: 'minimizeToTray' }), 'utf8');

      const winCloseCalls: Array<{ cmd: string; args: string[] }> = [];
      const winGuidedRes = await environmentProvisioner.startGuidedClientLogin(
        {
          targetId: 'host_gog',
          autoCloseOnSuccess: true,
          timeoutMs: 3000,
        },
        {
          platform: 'win32',
          homedir: winEnv.homedir,
          userDataDir: winEnv.userDataDir,
          gogGalaxyBinaryPath: winGogExe,
          pollIntervalMs: 20,
          postLoginFlushDelayMs: 10,
          connectedStorefronts: ['gog'],
          savedTokens: {
            gog: {
              access_token: 'gog_tok_valid_42',
              user_id: SYNTHETIC_GOG_INT64_PRIMARY,
            },
          },
          spawnFn: () => {
            setTimeout(() => {
              fs.writeFileSync(
                winLocalCfg,
                JSON.stringify({
                  userId: SYNTHETIC_GOG_INT64_PRIMARY,
                  username: 'SyntheticWinGalaxy42',
                }),
                'utf8'
              );
            }, 25);
            return { unref: vi.fn() };
          },
          execFileFn: (cmd: string, args: string[], opts: any, cb: Function) => {
            const callback = typeof opts === 'function' ? opts : cb;
            winCloseCalls.push({ cmd, args });
            if (typeof callback === 'function') callback(null, '', '');
            return {};
          },
        }
      );

      expect(winGuidedRes.success).toBe(true);
      expect(winGuidedRes.authenticated).toBe(true);
      expect(winGuidedRes.autoClosedClient).toBe(true);
      expect(winGuidedRes.probeState.accountMatchesOneLauncher).toBe(true);
      expect(winGuidedRes.probeState.detectedAccountLabel).toBe('SyntheticWinGalaxy42');
      expect(winCloseCalls.some((c) => c.args.includes('/command=shutdown'))).toBe(true);
      expect(
        winCloseCalls.some(
          (c) => c.cmd === 'taskkill.exe' && c.args.includes('/F') && c.args.includes('GalaxyClient.exe')
        )
      ).toBe(true);
    });
  });

  // ==========================================================================
  // 5. IPC Security Perimeter (launcherIpcHandlers.cjs)
  // ==========================================================================
  describe('5. IPC Security Perimeter & Untrusted Renderer Sanitization', () => {
    it('5.1 strips injected DI hooks/env vars and blocks bottleName/dmgPath traversal across all environment setup IPC channels', async () => {
      const handlers = new Map<string, Function>();
      const mockIpcMain = {
        handle: (channel: string, fn: Function) => {
          handlers.set(channel, fn);
        },
      };

      const capturedCalls: Record<string, any[]> = {
        probe: [],
        runTasks: [],
        guidedLogin: [],
        saveState: [],
      };

      const mockEngine = {
        probeEnvironmentHealth: vi.fn(async (opts: any) => {
          capturedCalls.probe.push(opts);
          return { ok: true };
        }),
        runEnvironmentSetupTasks: vi.fn(async (payload: any, opts: any) => {
          capturedCalls.runTasks.push({ payload, opts });
          return { success: true, runId: payload.runId || 'clean', outcomes: [], snapshot: {} };
        }),
        cancelEnvironmentSetup: vi.fn(async () => ({ success: true, cancelled: true })),
        startGuidedClientLogin: vi.fn(async (payload: any, opts: any) => {
          capturedCalls.guidedLogin.push({ payload, opts });
          return { success: true, targetId: payload.targetId, authenticated: true };
        }),
        cancelGuidedClientLogin: vi.fn(async () => ({ success: true, cancelled: true })),
        getSetupWizardState: vi.fn(async () => createDefaultSetupWizardState()),
        saveSetupWizardState: vi.fn(async (patch: any) => {
          capturedCalls.saveState.push(patch);
          return { success: true, state: { ...createDefaultSetupWizardState(), ...patch } };
        }),
      };

      launcherIpcHandlers.registerLauncherIpcHandlers({
        ipcMain: mockIpcMain,
        launcherEngine: mockEngine,
      });

      // 1) probe-environment-health strips DI functions, path overrides, and dynamic linker env vars
      await handlers.get('launcher:probe-environment-health')!(
        {},
        {
          connectedStorefronts: ['steam', 'not_a_real_store'],
          execFileFn: () => 'INJECTED',
          execFileImpl: () => 'INJECTED',
          fetchFn: () => 'INJECTED',
          homedir: '/Users/testuser/evil-override',
          userDataDir: '/Users/testuser/evil-userdata',
          customApplicationsDir: '/tmp/evil-apps',
          allowLoopbackInstallerUrls: true,
          allowAutoOpenInTest: true,
          DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
          LD_PRELOAD: '/tmp/evil.so',
        }
      );
      expect(capturedCalls.probe).toHaveLength(1);
      expect(capturedCalls.probe[0]).toEqual({ connectedStorefronts: ['steam'] });

      // 2) run-environment-setup-tasks rejects path-traversal bottleName & dmgPath & unknown actions
      for (const badPayload of [
        {
          runId: 'bad-bottle-1',
          tasks: [
            {
              action: 'ensure_bottle',
              componentId: 'bottle_default',
              bottleName: '../EscapeBottle',
            },
          ],
        },
        {
          runId: 'bad-bottle-2',
          tasks: [
            {
              action: 'ensure_bottle',
              componentId: 'bottle_default',
              bottleName: '..\\WindowsEscape',
            },
          ],
        },
        {
          runId: 'bad-bottle-null',
          tasks: [
            {
              action: 'ensure_bottle',
              componentId: 'bottle_default',
              bottleName: 'OneLauncher\0evil',
            },
          ],
        },
        {
          runId: 'bad-dmg-traversal',
          tasks: [
            {
              action: 'install_runner',
              componentId: 'runner_gptk',
              dmgPath: '/Users/testuser/Downloads/../../etc/passwd.dmg',
            },
          ],
        },
        {
          runId: 'bad-dmg-ext',
          tasks: [
            {
              action: 'install_runner',
              componentId: 'runner_gptk',
              dmgPath: '/Users/testuser/Downloads/Installer.pkg',
            },
          ],
        },
        {
          runId: 'bad-action',
          tasks: [{ action: 'exec_arbitrary_shell', componentId: 'rosetta2' }],
        },
      ]) {
        const res = await handlers.get('launcher:run-environment-setup-tasks')!({}, badPayload);
        expect(res.success).toBe(false);
      }
      expect(capturedCalls.runTasks).toHaveLength(0);

      // Valid payload strips injected hooks on task entries while preserving safe fields
      const goodRes = await handlers.get('launcher:run-environment-setup-tasks')!(
        {},
        {
          runId: 'valid-run-1',
          connectedStorefronts: ['steam', 'gog'],
          execFileFn: () => 'MUST_BE_STRIPPED',
          tasks: [
            {
              action: 'install_runner',
              componentId: 'runner_gptk',
              runnerType: 'gptk',
              dmgPath: '/Users/testuser/Downloads/Game_Porting_Toolkit_2.dmg',
              verifySignatureFn: () => true,
            },
            {
              action: 'ensure_bottle',
              componentId: 'bottle_default',
              runnerType: 'crossover',
              bottleMode: 'create_dedicated',
              bottleName: 'OneLauncher',
            },
          ],
        }
      );
      expect(goodRes.success).toBe(true);
      expect(capturedCalls.runTasks).toHaveLength(1);
      expect(capturedCalls.runTasks[0].opts).toEqual({});
      expect(capturedCalls.runTasks[0].payload).toEqual({
        runId: 'valid-run-1',
        connectedStorefronts: ['steam', 'gog'],
        tasks: [
          {
            action: 'install_runner',
            componentId: 'runner_gptk',
            runnerType: 'gptk',
            dmgPath: '/Users/testuser/Downloads/Game_Porting_Toolkit_2.dmg',
          },
          {
            action: 'ensure_bottle',
            componentId: 'bottle_default',
            runnerType: 'crossover',
            bottleMode: 'create_dedicated',
            bottleName: 'OneLauncher',
          },
        ],
      });

      // 3) start-guided-client-login blocks bottleName traversal & strips spawnClientFn
      const badLogin = await handlers.get('launcher:start-guided-client-login')!(
        {},
        {
          targetId: 'bottle_steam',
          bottleName: '../OutsidePrefix',
          spawnClientFn: () => {},
        }
      );
      expect(badLogin.success).toBe(false);
      expect(capturedCalls.guidedLogin).toHaveLength(0);

      // 4) save-setup-wizard-state strips allowAutoOpenInTest and traversal preferredBottleName
      await handlers.get('launcher:save-setup-wizard-state')!(
        {},
        {
          completedAt: '2026-10-30T10:00:00.000Z',
          preferredRunnerType: 'crossover',
          preferredBottleName: '../TraversalBottle',
          allowAutoOpenInTest: true,
          configuredComponents: ['runner_crossover', 'unknown_injected_id'],
        }
      );
      expect(capturedCalls.saveState).toHaveLength(1);
      expect(capturedCalls.saveState[0]).toEqual({
        completedAt: '2026-10-30T10:00:00.000Z',
        preferredRunnerType: 'crossover',
        configuredComponents: ['runner_crossover'],
      });
      expect(capturedCalls.saveState[0].allowAutoOpenInTest).toBeUndefined();
      expect(capturedCalls.saveState[0].preferredBottleName).toBeUndefined();
    });
  });

  // ==========================================================================
  // 6. React UI, Entry Points, First-Launch Auto-Open & WCAG 2.2 AA Audit
  // ==========================================================================
  describe('6. React UI Wizard Steps, Entry Points, First-Launch Gate & WCAG 2.2 AA Audit', () => {
    let prevWindow: any;
    let prevDocument: any;
    let prevLocalStorage: any;

    beforeEach(() => {
      prevWindow = (globalThis as any).window;
      prevDocument = (globalThis as any).document;
      prevLocalStorage = (globalThis as any).localStorage;

      const memStorage = createMemoryStorage();
      const eventListeners = new Map<string, Set<Function>>();

      Object.defineProperty(globalThis, 'localStorage', {
        value: memStorage,
        configurable: true,
        writable: true,
      });

      (globalThis as any).document = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        querySelectorAll: () => [],
      };

      (globalThis as any).window = {
        innerWidth: 1440,
        innerHeight: 900,
        localStorage: memStorage,
        location: { hostname: 'one-launcher.local', port: '', protocol: 'app:' },
        addEventListener: vi.fn((type: string, cb: Function) => {
          if (!eventListeners.has(type)) eventListeners.set(type, new Set());
          eventListeners.get(type)!.add(cb);
        }),
        removeEventListener: vi.fn((type: string, cb: Function) => {
          eventListeners.get(type)?.delete(cb);
        }),
        dispatchEvent: vi.fn((evt: any) => {
          const set = eventListeners.get(evt?.type);
          if (set) {
            for (const fn of set) fn(evt);
          }
          return true;
        }),
        electronAPI: {
          platform: 'darwin',
          arch: 'arm64',
          openExternal: vi.fn(),
        },
      };

      if (typeof (globalThis as any).CustomEvent !== 'function') {
        (globalThis as any).CustomEvent = class CustomEvent<T = any> {
          type: string;
          detail: T;
          constructor(type: string, init?: { detail?: T }) {
            this.type = type;
            this.detail = init?.detail as T;
          }
        };
      }
    });

    afterEach(() => {
      if (prevWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
      if (prevDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = prevDocument;
      if (prevLocalStorage === undefined) delete (globalThis as any).localStorage;
      else {
        Object.defineProperty(globalThis, 'localStorage', {
          value: prevLocalStorage,
          configurable: true,
          writable: true,
        });
      }
    });

    it('6.1 renders SystemSetupWizardModal across all 5 macOS steps with unchecked GOG/Epic defaults, removed-component 1-click repair, mismatch warning, native <progress>, and 0 WCAG 2.2 AA violations', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('ui-wizard');
      seedMockCrossOverApp(path.join(homedir, 'Applications'), '26.0.0');
      const bottlePath = seedInitializedCrossOverBottle(homedir, 'OneLauncher', {
        withSteam: true,
        withGogGalaxy: false,
      });

      // Seed bottled Steam with mismatched account + previously-configured host_steam & bottle_gog removed
      const bottleSteamVdf = path.join(
        bottlePath,
        'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'
      );
      fs.mkdirSync(path.dirname(bottleSteamVdf), { recursive: true });
      fs.writeFileSync(
        bottleSteamVdf,
        buildSteamLoginUsersVdf([
          {
            steamId64: SYNTHETIC_STEAM_ID_MISMATCH,
            accountName: 'otherplayer99',
            personaName: 'OtherPlayer99',
            mostRecent: true,
            allowAutoLogin: true,
          },
        ]),
        'utf8'
      );

      environmentHealthProber.saveSetupWizardState(
        {
          configuredComponents: ['rosetta2', 'host_steam'],
        },
        { homedir, userDataDir }
      );

      const realDriftedSnapshot: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: false,
          connectedStorefronts: ['steam', 'gog', 'epic'],
          savedTokens: {
            steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY },
            gog: { access_token: 'gog_tok_ui_42', user_id: SYNTHETIC_GOG_USER_ID_PRIMARY },
            epic: { access_token: 'epic_tok_ui_42', account_id: SYNTHETIC_EPIC_ACCOUNT_ID_PRIMARY },
          },
        });

      let progressCallback: ((evt: EnvironmentSetupProgressEvent) => void) | null = null;
      let resolveProvisioningRun: ((res: any) => void) | null = null;

      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([]);
      vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue({} as any);

      const saveStateSpy = vi.fn(async (patch: any) => ({
        success: true,
        state: {
          ...createDefaultSetupWizardState(),
          ...patch,
          configuredComponents: patch.configuredComponents || patch.addConfiguredComponents || [],
        },
      }));
      const guidedLoginSpy = vi.fn(async () => ({
        success: true,
        targetId: 'bottle_steam' as const,
        authenticated: true,
        autoClosedClient: true,
        probeState: {
          ...realDriftedSnapshot.clientLogins.bottle_steam,
          authenticated: true,
          accountMatchesOneLauncher: true,
          mismatchReason: undefined,
          detectedAccountLabel: 'TestPlayer42',
        },
        message: 'Signed in as TestPlayer42.',
      }));
      const runSetupSpy = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveProvisioningRun = resolve;
          })
      );

      (globalThis as any).window.electronAPI = {
        platform: 'darwin',
        arch: 'arm64',
        openExternal: vi.fn(),
        probeEnvironmentHealth: vi.fn(async () => realDriftedSnapshot),
        getSetupWizardState: vi.fn(async () => createDefaultSetupWizardState()),
        saveSetupWizardState: saveStateSpy,
        startGuidedClientLogin: guidedLoginSpy,
        cancelGuidedClientLogin: vi.fn(async () => ({ success: true, cancelled: true })),
        runEnvironmentSetupTasks: runSetupSpy,
        cancelEnvironmentSetup: vi.fn(async () => ({ success: true, cancelled: true })),
        onEnvironmentSetupProgress: vi.fn((cb: (evt: EnvironmentSetupProgressEvent) => void) => {
          progressCallback = cb;
          return () => {
            progressCallback = null;
          };
        }),
      };

      environmentSetupService.clearProgressHistory();
      await environmentSetupService.loadWizardState();
      await environmentSetupService.probeHealth(['steam', 'gog', 'epic']);

      const onCloseSpy = vi.fn();
      const wizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'first_launch',
        connectedStorefronts: ['steam', 'gog', 'epic'],
        onClose: onCloseSpy,
        onOpenIntegrationsModal: vi.fn(),
      });

      try {
        // Initial render (Step 1 on macOS: 1. Accounts; Step 1 System/Rosetta removed & handled in background)
        let tree = wizard.render();
        await Promise.resolve();
        await Promise.resolve();
        tree = wizard.render();

        const dialogNode = findVNodeByTestId(tree, 'system-setup-wizard-modal');
        expect(dialogNode).toBeDefined();
        const headingNode = findVNodes(
          tree,
          (n) => n.props?.id === dialogNode.props['aria-labelledby']
        )[0];
        expect(headingNode).toBeDefined();
        expect(extractVNodeText(headingNode)).toBe('Setup Wizard');
        expect(findVNodeByTestId(tree, 'setup-close-icon-btn').props['aria-label']).toBe(
          'Close Setup Wizard'
        );

        // Step 1 System/Rosetta is omitted on macOS (Rosetta 2 is checked/installed in background)
        expect(findVNodeByTestId(tree, 'setup-step-tab-prerequisites')).toBeUndefined();
        expect(findVNodeByTestId(tree, 'bundled-helper-gogdl')).toBeUndefined();
        expect(findVNodeByTestId(tree, 'mac-applications-target-card')).toBeUndefined();

        // Only user-facing removed components (host_steam) appear in the removed banner on macOS
        expect(findVNodeByTestId(tree, 'removed-components-banner')).toBeDefined();
        expect(extractVNodeText(findVNodeByTestId(tree, 'removed-components-banner'))).toContain(
          'Some setup items were removed (1)'
        );
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeUndefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // Advance via Next to Step 2 (compatibility: 2. Windows Games) & audit
        findVNodeByTestId(tree, 'setup-next-step-btn').props.onClick();
        tree = wizard.render();
        expect(findVNodeByTestId(tree, 'setup-step-compatibility')).toBeDefined();
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeUndefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // Advance via Next to Step 3 (clients: 3. Launchers): verify GOG & Epic unchecked by default
        findVNodeByTestId(tree, 'setup-next-step-btn').props.onClick();
        tree = wizard.render();
        expect(auditWcag22AA(tree)).toEqual([]);

        expect(findVNodeByTestId(tree, 'setup-toggle-host_steam').props.checked).toBe(true);
        expect(findVNodeByTestId(tree, 'setup-toggle-host_gog').props.checked).toBe(false);
        expect(findVNodeByTestId(tree, 'setup-toggle-bottle_gog').props.checked).toBe(false);
        expect(findVNodeByTestId(tree, 'setup-toggle-host_epic').props.checked).toBe(false);
        expect(findVNodeByTestId(tree, 'setup-toggle-bottle_epic').props.checked).toBe(false);

        // Uncheck host_steam first to prove 1-click "Reinstall Missing" restores removed selections
        findVNodeByTestId(tree, 'setup-toggle-host_steam').props.onChange();
        tree = wizard.render();
        expect(findVNodeByTestId(tree, 'setup-toggle-host_steam').props.checked).toBe(false);

        const clientsText = extractVNodeText(findVNodeByTestId(tree, 'setup-step-clients'));
        expect(clientsText).toContain('downloads and cloud saves already work without it');
        expect(findVNodeByTestId(tree, 'setup-client-card-xbox_runtime')).toBeUndefined();

        // Advance via Next -> Step 4 (summary) -> Next -> Step 5 (client_logins)
        findVNodeByTestId(tree, 'setup-next-step-btn').props.onClick();
        tree = wizard.render();
        findVNodeByTestId(tree, 'setup-next-step-btn').props.onClick();
        tree = wizard.render();
        expect(auditWcag22AA(tree)).toEqual([]);
        expect(findVNodeByTestId(tree, 'guided-login-card-host_gog')).toBeUndefined();
        expect(findVNodeByTestId(tree, 'guided-login-card-bottle_gog')).toBeUndefined();
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeUndefined();

        const mismatchAlert = findVNodeByTestId(tree, 'client-mismatch-bottle_steam');
        expect(mismatchAlert).toBeDefined();
        expect(extractVNodeText(mismatchAlert)).toContain('Different account signed in');
        expect(extractVNodeText(mismatchAlert)).toContain('OtherPlayer99');

        findVNodeByTestId(tree, 'guided-login-btn-bottle_steam').props.onClick();
        await Promise.resolve();
        await Promise.resolve();
        expect(guidedLoginSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            targetId: 'bottle_steam',
            autoCloseOnSuccess: true,
          })
        );
        tree = wizard.render();
        expect(auditWcag22AA(tree)).toEqual([]);

        // Click 1-click "Reinstall Missing" banner button -> selects removed items & jumps to Step 4 (summary)
        findVNodeByTestId(tree, 'repair-removed-components-btn').props.onClick();
        tree = wizard.render();
        expect(auditWcag22AA(tree)).toEqual([]);
        expect(findVNodeByTestId(tree, 'planned-task-rosetta2-install_rosetta2')).toBeUndefined();
        expect(findVNodeByTestId(tree, 'planned-task-host_steam-install_client')).toBeDefined();
        // Finish Setup MUST NOT appear while planned install tasks remain
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeUndefined();

        // Start provisioning -> verify native <progress> indeterminate (no value attr) then determinate (value=65)
        findVNodeByTestId(tree, 'run-provisioning-btn').props.onClick();
        tree = wizard.render();
        expect(runSetupSpy).toHaveBeenCalledTimes(1);
        expect(findVNodeByTestId(tree, 'system-setup-wizard-modal').props.closedby).toBe('none');
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeUndefined();

        const indeterminateProgress = findVNodes(tree, (n) => n.type === 'progress')[0];
        expect(indeterminateProgress).toBeDefined();
        expect(indeterminateProgress.props.value).toBeUndefined();
        expect(renderToStaticMarkup(indeterminateProgress)).not.toContain('value=');
        expect(auditWcag22AA(tree)).toEqual([]);

        // Emit determinate byte progress event (65%)
        expect(progressCallback).not.toBeNull();
        progressCallback!({
          runId: 'ui-run-1',
          componentId: 'host_steam',
          stepIndex: 0,
          totalSteps: 2,
          phase: 'downloading',
          progressPercent: 65,
          bytesDownloaded: 65 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          message: 'Downloading Steam for macOS...',
        });
        tree = wizard.render();
        const determinateProgress = findVNodes(tree, (n) => n.type === 'progress')[0];
        expect(determinateProgress.props.value).toBe(65);
        expect(auditWcag22AA(tree)).toEqual([]);

        // Resolve provisioning run with all tasks & sign-ins completed -> Finish Setup now appears
        const completedSnapshot: EnvironmentHealthSnapshot = {
          ...realDriftedSnapshot,
          components: {
            ...realDriftedSnapshot.components,
            rosetta2: {
              ...realDriftedSnapshot.components.rosetta2,
              status: 'ready',
              defaultSelected: false,
            },
            host_steam: {
              ...realDriftedSnapshot.components.host_steam,
              status: 'ready',
              defaultSelected: false,
            },
          },
          clientLogins: {
            ...realDriftedSnapshot.clientLogins,
            host_steam: {
              ...realDriftedSnapshot.clientLogins.host_steam,
              installed: true,
              authenticated: true,
              accountMatchesOneLauncher: true,
              detectedAccountLabel: 'TestPlayer42',
              statusSummary: 'Signed in as TestPlayer42',
            },
            bottle_steam: {
              ...realDriftedSnapshot.clientLogins.bottle_steam,
              installed: true,
              authenticated: true,
              accountMatchesOneLauncher: true,
              mismatchReason: undefined,
              detectedAccountLabel: 'TestPlayer42',
              statusSummary: 'Signed in as TestPlayer42',
            },
          },
          counts: {
            ...realDriftedSnapshot.counts,
            missingRecommendedCount: 0,
            removedSinceLastSetupCount: 0,
            pendingClientLoginCount: 0,
            accountMismatchCount: 0,
          },
        };

        resolveProvisioningRun!({
          success: true,
          runId: 'ui-run-1',
          outcomes: [
            {
              componentId: 'rosetta2',
              action: 'install_rosetta2',
              status: 'completed',
              message: 'Installed Rosetta 2.',
            },
            {
              componentId: 'host_steam',
              action: 'install_client',
              status: 'completed',
              installedPath: '/Users/testuser/Applications/Steam.app',
              message: 'Installed Steam.',
            },
          ],
          snapshot: completedSnapshot,
        });
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();
        expect(findVNodeByTestId(tree, 'setup-outcome-host_steam-install_client')).toBeDefined();
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeDefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // Finish Setup -> saves completedAt and closes modal
        findVNodeByTestId(tree, 'finish-setup-btn').props.onClick();
        await new Promise((r) => setTimeout(r, 0));
        expect(saveStateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            completedAt: expect.any(String),
          })
        );
        expect(onCloseSpy).toHaveBeenCalledTimes(1);

        // Also verify Skip for Now in first_launch mode persists dismissedAt
        saveStateSpy.mockClear();
        tree = wizard.render({ mode: 'first_launch' });
        findVNodeByTestId(tree, 'setup-skip-btn').props.onClick();
        await new Promise((r) => setTimeout(r, 0));
        expect(saveStateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            dismissedAt: expect.any(String),
          })
        );
      } finally {
        wizard.unmount();
      }
    });

    it('6.2 verifies TopNavBar burger-menu entry + alert dot, GameInstallModal missing-runner callout, CompatibilityLayerSection button, and shouldAutoOpenSetupWizardOnStartup gate', async () => {
      const openedEvents: any[] = [];
      (globalThis as any).window.addEventListener(OPEN_SYSTEM_SETUP_EVENT, (evt: any) => {
        openedEvents.push(evt.detail);
      });

      // A) TopNavBar Burger Menu item + alert dot badge
      const onOpenSystemSetup = vi.fn();
      const nav = createDomain12DeepRenderer(TopNavBar, {
        selectedPlatform: 'all',
        onSelectPlatform: vi.fn(),
        installedOnly: false,
        onToggleInstalledOnly: vi.fn(),
        totalGamesCount: 12,
        filteredCount: 12,
        isSyncing: false,
        onTriggerSync: vi.fn(),
        onHomeClick: vi.fn(),
        onOpenIntegrations: vi.fn(),
        onOpenSystemSetup,
        systemSetupAlertCount: 2,
        defaultMenuOpen: true,
      });
      try {
        let navTree = nav.render();
        const menuBtn = findVNodeByTestId(navTree, 'menu-system-setup-health');
        const alertDot = findVNodeByTestId(navTree, 'menu-system-setup-alert-dot');
        expect(menuBtn).toBeDefined();
        expect(extractVNodeText(menuBtn)).toContain('Setup Wizard');
        expect(extractVNodeText(menuBtn)).not.toContain('Environment Health');
        expect(alertDot).toBeDefined();
        menuBtn.props.onClick();
        expect(onOpenSystemSetup).toHaveBeenCalledTimes(1);

        // When alert count is 0, alert dot is omitted
        navTree = nav.render({ defaultMenuOpen: true, systemSetupAlertCount: 0 });
        expect(findVNodeByTestId(navTree, 'menu-system-setup-alert-dot')).toBeUndefined();
      } finally {
        nav.unmount();
      }

      // B) GameInstallModal missing-compat-runner-setup-callout on macOS when 0 runners exist
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        targetPath: '/Users/testuser/Games',
        freeBytes: 80 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        usedBytes: 420 * 1024 * 1024 * 1024,
      });
      const winOnlyInstallInfo: GameInstallInfo = {
        platformId: 'gog',
        platformGameId: '1207658924',
        canDirectDownload: true,
        defaultInstallDir: '/Users/testuser/Games/GOG',
        availableInstallDirs: ['/Users/testuser/Games/GOG'],
        availableInstallers: [
          {
            id: 'gog_win_en',
            name: 'Windows Installer',
            os: 'windows',
            language: 'en',
            totalSizeBytes: 2 * 1024 * 1024 * 1024,
          },
        ],
      };
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue(winOnlyInstallInfo);

      const gameFixture: CanonicalGame = makeCanonicalGameFixture({
        id: 'gog-1207658924',
        title: 'Synthetic Frontier 2099',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1207658924',
            installed: false,
          },
        ],
      });

      const installModal = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game: gameFixture,
        initialPlatformId: 'gog',
        onClose: vi.fn(),
      });
      try {
        let modalTree = installModal.render();
        await Promise.resolve();
        await Promise.resolve();
        modalTree = installModal.render();

        const callout = findVNodeByTestId(modalTree, 'missing-compat-runner-setup-callout');
        expect(callout).toBeDefined();
        expect(extractVNodeText(callout)).toContain('Windows game support isn’t set up yet');

        const openWizBtn = findVNodeByTestId(modalTree, 'open-setup-wizard-from-install-btn');
        expect(openWizBtn).toBeDefined();
        expect(extractVNodeText(openWizBtn)).toContain('Setup Wizard...');
        openWizBtn.props.onClick();
        expect(openedEvents).toContainEqual({
          mode: 'repair',
          initialStep: 'compatibility',
        });
      } finally {
        installModal.unmount();
      }

      // C) CompatibilityLayerSection "Setup Wizard..." button
      const emptyModeNote = { dynamicDesc: 'Compatible' };
      const mockPreview: ResolvedLaunchModePreview = {
        isInstalled: true,
        hostPlatform: 'darwin',
        platformId: 'gog',
        detectedBuildType: 'windows_exe_on_mac',
        detectedBuildLabel: 'Windows x64 Build (via Bottle)',
        detectedBuildDetail: 'Runs via CrossOver bottle',
        autoResolvedMethod: 'compatibility_layer',
        autoResolvedSummary: 'Runs via CrossOver bottle.',
        defaultLaunchMethod: 'auto',
        recommendedModes: ['auto', 'compatibility_layer'],
        availableModes: ['auto', 'compatibility_layer', 'direct'],
        visibleSections: {
          compatibilityLayer: true,
          crossoverRendering: true,
          nativeMacMetalHud: false,
          executableAndArgs: true,
          environmentAndHooks: true,
        },
        modeNotes: {
          auto: emptyModeNote,
          direct: emptyModeNote,
          storefront_uri: emptyModeNote,
          compatibility_layer: emptyModeNote,
          custom: emptyModeNote,
        },
      };
      const mockDescriptor: CompatibilityRunnerDescriptor = {
        type: 'crossover',
        label: 'CrossOver by CodeWeavers',
        shortLabel: 'CrossOver',
        vendor: 'CodeWeavers',
        description: 'Windows compatibility layer with D3DMetal & DXMT.',
        bestFor: 'DirectX 11/12 Windows games',
        downloadUrl: 'https://www.codeweavers.com/crossover',
        downloadLabel: 'Download CrossOver',
      };
      const mockLayers: CompatibilityLayerInfo[] = [];

      const compatSection = createDomain12DeepRenderer(CompatibilityLayerSection, {
        isWindowsHost: false,
        preview: mockPreview,
        activeDisplayMethod: 'compatibility_layer',
        detectedLayers: mockLayers,
        runnerUpdates: {},
        compatibilityLayer: 'crossover',
        onSelectCompatibilityLayer: vi.fn(),
        availableBottles: [],
        wineBottleName: 'OneLauncher',
        onChangeWineBottleName: vi.fn(),
        selectedRunnerDescriptor: mockDescriptor,
        activeSecondaryBuildText: '',
        isCheckingUpdates: false,
        isUpdatingRunner: false,
        onUpdateRunner: vi.fn(),
        onCheckRunnerUpdates: vi.fn(),
        onOpenBottleFolder: vi.fn(),
        isRescanningRunners: false,
        onRescanLayers: vi.fn(),
        isInstallingRunner: false,
        onInstallRunnerViaBrew: vi.fn(),
        onDownloadRunner: vi.fn(),
        runnerUpdateFeedback: null,
        runnerActionFeedback: null,
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
        isDlssSupportedBackend: true,
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
      try {
        const secTree = compatSection.render();
        expect(auditWcag22AA(secTree)).toEqual([]);
        openedEvents.length = 0;
        const wizTrigger = findVNodeByTestId(secTree, 'open-system-setup-wizard-btn');
        expect(wizTrigger).toBeDefined();
        expect(extractVNodeText(wizTrigger)).toContain('Setup Wizard...');
        wizTrigger.props.onClick();
        expect(openedEvents).toEqual([
          {
            mode: 'repair',
            initialStep: 'compatibility',
          },
        ]);
      } finally {
        compatSection.unmount();
      }

      // D) First-launch auto-open gate (shouldAutoOpenSetupWizardOnStartup + localStorage fallback)
      const unconfiguredForTest: SetupWizardPersistedState = {
        ...createDefaultSetupWizardState(),
        allowAutoOpenInTest: true,
      };

      // True ONLY on unconfigured Electron first launch
      expect(
        shouldAutoOpenSetupWizardOnStartup({
          wizardState: unconfiguredForTest,
          connectedStorefrontsCount: 0,
          catalogGamesCount: 0,
          isElectronRuntime: true,
        })
      ).toBe(true);

      // Never auto-opens in standard Vitest suites unless allowAutoOpenInTest === true
      expect(
        shouldAutoOpenSetupWizardOnStartup({
          wizardState: createDefaultSetupWizardState(),
          connectedStorefrontsCount: 0,
          catalogGamesCount: 0,
          isElectronRuntime: true,
        })
      ).toBe(false);

      // Never auto-opens outside Electron, or once completed/dismissed, or if storefronts/games already exist
      expect(
        shouldAutoOpenSetupWizardOnStartup({
          wizardState: unconfiguredForTest,
          connectedStorefrontsCount: 0,
          catalogGamesCount: 0,
          isElectronRuntime: false,
        })
      ).toBe(false);
      expect(
        shouldAutoOpenSetupWizardOnStartup({
          wizardState: { ...unconfiguredForTest, completedAt: '2026-10-30T00:00:00.000Z' },
          connectedStorefrontsCount: 0,
          catalogGamesCount: 0,
          isElectronRuntime: true,
        })
      ).toBe(false);
      expect(
        shouldAutoOpenSetupWizardOnStartup({
          wizardState: { ...unconfiguredForTest, dismissedAt: '2026-10-30T00:00:00.000Z' },
          connectedStorefrontsCount: 0,
          catalogGamesCount: 0,
          isElectronRuntime: true,
        })
      ).toBe(false);
      expect(
        shouldAutoOpenSetupWizardOnStartup({
          wizardState: unconfiguredForTest,
          connectedStorefrontsCount: 1,
          catalogGamesCount: 0,
          isElectronRuntime: true,
        })
      ).toBe(false);
      expect(
        shouldAutoOpenSetupWizardOnStartup({
          wizardState: unconfiguredForTest,
          connectedStorefrontsCount: 0,
          catalogGamesCount: 5,
          isElectronRuntime: true,
        })
      ).toBe(false);

      // Verify EnvironmentSetupService localStorage fallback persists & reloads state cleanly
      delete (globalThis as any).window.electronAPI.saveSetupWizardState;
      delete (globalThis as any).window.electronAPI.getSetupWizardState;
      const isolatedSvc = new EnvironmentSetupService();
      await isolatedSvc.saveWizardState({
        preferredRunnerType: 'wine',
        preferredBottleName: 'IndiePrefix',
        configuredComponents: ['runner_wine'],
      });
      const rawStored = (globalThis as any).localStorage.getItem(WIZARD_STATE_STORAGE_KEY);
      expect(rawStored).toBeTruthy();
      const reloaded = await isolatedSvc.loadWizardState();
      expect(reloaded.preferredRunnerType).toBe('wine');
      expect(reloaded.preferredBottleName).toBe('IndiePrefix');
      expect(reloaded.configuredComponents).toEqual(['runner_wine']);
    });

    it('6.3 renders Step 5 (Review & Provision) failure state with AlertCircle/rose styling, non-duplicative polite status, progress aria-valuetext, formatted CrossOver label, and 0 WCAG 2.2 AA violations', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('ui-step6-failure');
      const snapshot: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: false,
          connectedStorefronts: ['steam', 'gog'],
          savedTokens: {
            steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY },
            gog: { access_token: 'gog_tok_ui_step6', user_id: SYNTHETIC_GOG_USER_ID_PRIMARY },
          },
        });

      let progressCallback: ((evt: EnvironmentSetupProgressEvent) => void) | null = null;
      let resolveProvisioningRun: ((res: any) => void) | null = null;

      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([]);
      vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue({} as any);

      (globalThis as any).window.electronAPI = {
        platform: 'darwin',
        arch: 'arm64',
        openExternal: vi.fn(),
        probeEnvironmentHealth: vi.fn(async () => snapshot),
        getSetupWizardState: vi.fn(async () => ({
          ...createDefaultSetupWizardState(),
          preferredRunnerType: 'crossover',
          preferredBottleName: 'OneLauncher',
        })),
        saveSetupWizardState: vi.fn(async (patch: any) => ({
          success: true,
          state: { ...createDefaultSetupWizardState(), ...patch },
        })),
        startGuidedClientLogin: vi.fn(),
        cancelGuidedClientLogin: vi.fn(async () => ({ success: true, cancelled: true })),
        runEnvironmentSetupTasks: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveProvisioningRun = resolve;
            })
        ),
        cancelEnvironmentSetup: vi.fn(async () => ({ success: true, cancelled: true })),
        onEnvironmentSetupProgress: vi.fn((cb: (evt: EnvironmentSetupProgressEvent) => void) => {
          progressCallback = cb;
          return () => {
            progressCallback = null;
          };
        }),
      };

      environmentSetupService.clearProgressHistory();
      await environmentSetupService.loadWizardState();
      await environmentSetupService.probeHealth(['steam', 'gog']);

      const wizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        initialStep: 'summary',
        connectedStorefronts: ['steam', 'gog'],
        onClose: vi.fn(),
      });

      try {
        let tree = wizard.render();
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();

        // 1) Verify summary cards display human-readable 'Steam, GOG' and 'CrossOver • "OneLauncher"'
        const summaryRoot = findVNodeByTestId(tree, 'setup-step-summary');
        expect(summaryRoot).toBeDefined();
        const summaryText = extractVNodeText(summaryRoot);
        expect(summaryText).toContain('Steam, GOG');
        expect(summaryText).not.toContain('STEAM, GOG');
        expect(summaryText).toContain('CrossOver • "OneLauncher"');
        expect(summaryText).not.toContain('crossover •');
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeUndefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // 2) Start provisioning and emit active progress -> verify <progress> carries aria-valuetext
        findVNodeByTestId(tree, 'run-provisioning-btn').props.onClick();
        tree = wizard.render();
        expect(progressCallback).not.toBeNull();
        progressCallback!({
          runId: 'ui-fail-run-1',
          componentId: 'bottle_gog',
          stepIndex: 1,
          totalSteps: 2,
          phase: 'downloading',
          progressPercent: 42,
          bytesDownloaded: 42 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          message: 'Downloading Windows GOG Galaxy Installer...',
        });
        tree = wizard.render();

        const runningProgress = findVNodes(tree, (n) => n.type === 'progress')[0];
        expect(runningProgress).toBeDefined();
        expect(runningProgress.props.value).toBe(42);
        expect(runningProgress.props['aria-valuetext']).toBe(
          'Downloading Windows GOG Galaxy Installer...'
        );
        expect(auditWcag22AA(tree)).toEqual([]);

        // 3) Finish provisioning with a task failure (lastRunError present, overall run finished)
        const rawFailureError = 'HTTP 503 while downloading GOG Galaxy CDN payload.';
        resolveProvisioningRun!({
          success: false,
          runId: 'ui-fail-run-1',
          error: rawFailureError,
          outcomes: [
            {
              componentId: 'rosetta2',
              action: 'install_rosetta2',
              status: 'completed',
              message: 'Installed Rosetta 2.',
            },
            {
              componentId: 'bottle_gog',
              action: 'install_client',
              status: 'failed',
              message: rawFailureError,
              error: rawFailureError,
            },
          ],
          snapshot,
        });
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();

        const panel = findVNodeByTestId(tree, 'provisioning-progress-panel');
        expect(panel).toBeDefined();

        // Finish Setup MUST NOT appear when lastRunError is present
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeUndefined();

        // Polite role="status" uses rose AlertCircle (no emerald CheckCircle2) and concise non-duplicative text
        const statusRegions = findVNodes(panel, (n) => n.props?.role === 'status');
        expect(statusRegions).toHaveLength(1);
        const statusNode = statusRegions[0];
        const statusText = extractVNodeText(statusNode);
        expect(statusText).toMatch(/Setup finished with 1 issue \(1 of 2 completed\)\./);
        expect(statusText).not.toContain(rawFailureError);

        const statusIcons = findVNodes(statusNode, (n) => n.type === 'svg');
        expect(statusIcons).toHaveLength(1);
        expect(String(statusIcons[0].props.className || '')).toContain('text-rose-400');
        expect(String(statusIcons[0].props.className || '')).not.toContain('text-emerald-400');

        // Assertive role="alert" displays the detailed lastRunError with rose styling
        const alertRegions = findVNodes(panel, (n) => n.props?.role === 'alert');
        expect(alertRegions).toHaveLength(1);
        expect(String(alertRegions[0].props.className || '')).toContain('bg-rose-950/60');
        expect(extractVNodeText(alertRegions[0])).toContain(rawFailureError);

        // Zero WCAG 2.2 AA violations on the completed-with-errors view
        expect(auditWcag22AA(tree)).toEqual([]);
      } finally {
        wizard.unmount();
      }
    });

    it('6.4 enforces Step 5 (Install) -> Step 6 (Sign In) ordering, Finish Setup gating, installed-only filtering, and sequential launcher sign-in queue with Skip & forceInteractiveLogin', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('ui-sequential-signins');
      const initialSnapshot: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: true,
          connectedStorefronts: ['steam', 'gog'],
          savedTokens: {
            steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY },
            gog: { access_token: 'gog_tok_seq_42', user_id: SYNTHETIC_GOG_USER_ID_PRIMARY },
          },
        });

      // Seed CrossOver + OneLauncher bottle + host_steam, bottle_steam, bottle_gog installed & unsigned for post-provision snapshot
      seedMockCrossOverApp(path.join(homedir, 'Applications'), '26.0.0');
      const hostSteamBin = path.join(homedir, 'Applications/Steam.app/Contents/MacOS/steam_osx');
      fs.mkdirSync(path.dirname(hostSteamBin), { recursive: true });
      fs.writeFileSync(hostSteamBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      seedInitializedCrossOverBottle(homedir, 'OneLauncher', {
        withSteam: true,
        withGogGalaxy: true,
      });

      const postProvisionSnapshot: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: true,
          connectedStorefronts: ['steam', 'gog'],
          savedTokens: {
            steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY },
            gog: { access_token: 'gog_tok_seq_42', user_id: SYNTHETIC_GOG_USER_ID_PRIMARY },
          },
        });

      expect(postProvisionSnapshot.clientLogins.host_steam.installed).toBe(true);
      expect(postProvisionSnapshot.clientLogins.host_steam.authenticated).toBe(false);
      expect(postProvisionSnapshot.clientLogins.bottle_steam.installed).toBe(true);
      expect(postProvisionSnapshot.clientLogins.bottle_steam.authenticated).toBe(false);
      expect(postProvisionSnapshot.clientLogins.bottle_gog.installed).toBe(true);
      expect(postProvisionSnapshot.clientLogins.bottle_gog.authenticated).toBe(false);

      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([]);
      vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue({} as any);

      let resolveProvisioningRun: ((res: any) => void) | null = null;
      const guidedLoginCalls: StartGuidedClientLoginRequest[] = [];
      const pendingGuidedResolvers = new Map<
        ClientLoginTargetId,
        (res: GuidedClientLoginResult) => void
      >();

      const cancelGuidedSpy = vi.fn(async (targetId?: ClientLoginTargetId) => {
        if (targetId && pendingGuidedResolvers.has(targetId)) {
          const resolveFn = pendingGuidedResolvers.get(targetId)!;
          pendingGuidedResolvers.delete(targetId);
          const curProbe =
            environmentSetupService.getLastSnapshot()?.clientLogins[targetId] ||
            postProvisionSnapshot.clientLogins[targetId];
          resolveFn({
            success: false,
            targetId,
            authenticated: false,
            cancelled: true,
            probeState: curProbe,
            message: `Cancelled sign-in watcher for ${curProbe.label}.`,
          });
        }
        return { success: true, targetId, cancelled: true };
      });

      const startGuidedSpy = vi.fn(
        (req: StartGuidedClientLoginRequest) =>
          new Promise<GuidedClientLoginResult>((resolve) => {
            guidedLoginCalls.push(req);
            pendingGuidedResolvers.set(req.targetId, resolve);
          })
      );

      let currentProbeResponse: EnvironmentHealthSnapshot = initialSnapshot;

      (globalThis as any).window.electronAPI = {
        platform: 'darwin',
        arch: 'arm64',
        openExternal: vi.fn(),
        probeEnvironmentHealth: vi.fn(async () => currentProbeResponse),
        getSetupWizardState: vi.fn(async () => ({
          ...createDefaultSetupWizardState(),
          preferredRunnerType: 'crossover',
          preferredBottleName: 'OneLauncher',
        })),
        saveSetupWizardState: vi.fn(async (patch: any) => ({
          success: true,
          state: { ...createDefaultSetupWizardState(), ...patch },
        })),
        startGuidedClientLogin: startGuidedSpy,
        cancelGuidedClientLogin: cancelGuidedSpy,
        runEnvironmentSetupTasks: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveProvisioningRun = resolve;
            })
        ),
        cancelEnvironmentSetup: vi.fn(async () => ({ success: true, cancelled: true })),
        onEnvironmentSetupProgress: vi.fn(() => () => {}),
      };

      environmentSetupService.clearProgressHistory();
      await environmentSetupService.loadWizardState();
      await environmentSetupService.probeHealth(['steam', 'gog']);

      const wizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'first_launch',
        initialStep: 'summary',
        connectedStorefronts: ['steam', 'gog'],
        onClose: vi.fn(),
      });

      try {
        let tree = wizard.render();
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();

        // 1) Verify WIZARD_STEPS on macOS renders 5 steps ('4. Install' BEFORE '5. Sign In', omitting Step 1 System)
        const stepTabNodes = findVNodes(
          tree,
          (n) =>
            typeof n.props?.['data-testid'] === 'string' &&
            n.props['data-testid'].startsWith('setup-step-tab-')
        );
        expect(stepTabNodes.map((n) => n.props['data-testid'])).toEqual([
          'setup-step-tab-accounts',
          'setup-step-tab-compatibility',
          'setup-step-tab-clients',
          'setup-step-tab-summary',
          'setup-step-tab-client_logins',
        ]);
        expect(extractVNodeText(findVNodeByTestId(tree, 'setup-step-tab-accounts'))).toContain(
          '1. Accounts'
        );
        expect(extractVNodeText(findVNodeByTestId(tree, 'setup-step-tab-compatibility'))).toContain(
          '2. Windows Games'
        );
        expect(extractVNodeText(findVNodeByTestId(tree, 'setup-step-tab-summary'))).toContain(
          '4. Install'
        );
        expect(extractVNodeText(findVNodeByTestId(tree, 'setup-step-tab-client_logins'))).toContain(
          '5. Sign In'
        );
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeUndefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // 2) Run provisioning on Step 5 -> complete with 3 newly installed unsigned launchers
        findVNodeByTestId(tree, 'run-provisioning-btn').props.onClick();
        tree = wizard.render();
        currentProbeResponse = postProvisionSnapshot;
        resolveProvisioningRun!({
          success: true,
          runId: 'ui-seq-prov-1',
          outcomes: [
            {
              componentId: 'runner_crossover',
              action: 'install_runner',
              status: 'completed',
              message: 'Installed CrossOver.',
            },
            {
              componentId: 'bottle_default',
              action: 'ensure_bottle',
              status: 'completed',
              message: 'Created bottle OneLauncher.',
            },
            {
              componentId: 'host_steam',
              action: 'install_client',
              status: 'completed',
              message: 'Installed Steam (Mac).',
            },
            {
              componentId: 'bottle_steam',
              action: 'install_client',
              status: 'completed',
              message: 'Installed Steam (Windows).',
            },
            {
              componentId: 'bottle_gog',
              action: 'install_client',
              status: 'completed',
              message: 'Installed GOG Galaxy (Windows).',
            },
          ],
          snapshot: postProvisionSnapshot,
        });
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();

        const postProvCallout = findVNodeByTestId(tree, 'post-provision-signin-callout');
        const continueToSignInsBtn = findVNodeByTestId(tree, 'continue-to-guided-signins-btn');
        expect(postProvCallout).toBeDefined();
        expect(extractVNodeText(postProvCallout)).toContain('3 launchers need sign-in');
        expect(continueToSignInsBtn).toBeDefined();
        // Finish Setup MUST NOT render while 3 launchers still need sign-in!
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeUndefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // Navigate to Step 6 via continue-to-guided-signins-btn
        continueToSignInsBtn.props.onClick();
        tree = wizard.render();
        expect(findVNodeByTestId(tree, 'setup-step-client-logins')).toBeDefined();
        // Finish Setup MUST STILL NOT render on Step 6 while unsigned launchers remain unskipped!
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeUndefined();
        // Uninstalled optional launchers are omitted from Step 6
        expect(findVNodeByTestId(tree, 'guided-login-card-host_gog')).toBeUndefined();
        expect(findVNodeByTestId(tree, 'guided-login-card-host_epic')).toBeUndefined();
        expect(findVNodeByTestId(tree, 'guided-login-card-bottle_epic')).toBeUndefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // 3) Step 6 Sequential "Sign In One by One" Queue
        const idleSeqBanner = findVNodeByTestId(tree, 'sequential-signin-banner');
        expect(idleSeqBanner).toBeDefined();
        expect(extractVNodeText(idleSeqBanner)).toContain(
          '1. Steam (Mac)  →  2. Steam (Windows)  →  3. GOG Galaxy (Windows)'
        );

        // Step 3a: Start queue -> launches ONLY host_steam first (1 of 3)
        findVNodeByTestId(tree, 'start-sequential-signin-btn').props.onClick();
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();

        expect(guidedLoginCalls.map((c) => c.targetId)).toEqual(['host_steam']);
        let seqProgress = findVNodes(tree, (n) => n.type === 'progress')[0];
        expect(seqProgress).toBeDefined();
        expect(seqProgress.props.value).toBe(0);
        expect(seqProgress.props.max).toBe(3);
        expect(String(seqProgress.props['aria-valuetext'] || '')).toContain('1 of 3');
        expect(auditWcag22AA(tree)).toEqual([]);

        // Step 3b: Resolve host_steam -> queue automatically advances & launches bottle_steam (2 of 3)
        pendingGuidedResolvers.get('host_steam')!({
          success: true,
          targetId: 'host_steam',
          authenticated: true,
          autoClosedClient: true,
          probeState: {
            ...postProvisionSnapshot.clientLogins.host_steam,
            authenticated: true,
            accountMatchesOneLauncher: true,
            detectedAccountLabel: 'TestPlayer42',
            statusSummary: 'Signed in as TestPlayer42',
          },
          message: 'Signed into Steam (Mac) as TestPlayer42.',
        });
        pendingGuidedResolvers.delete('host_steam');
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();

        expect(guidedLoginCalls.map((c) => c.targetId)).toEqual(['host_steam', 'bottle_steam']);
        seqProgress = findVNodes(tree, (n) => n.type === 'progress')[0];
        expect(seqProgress.props.value).toBe(1);
        expect(seqProgress.props.max).toBe(3);
        expect(String(seqProgress.props['aria-valuetext'] || '')).toContain('2 of 3');
        expect(auditWcag22AA(tree)).toEqual([]);

        // Step 3c: Click 'Skip & Next' while bottle_steam is waiting -> cancels bottle_steam & launches bottle_gog (3 of 3)
        findVNodeByTestId(tree, 'sequential-signin-skip-btn').props.onClick();
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();

        expect(cancelGuidedSpy).toHaveBeenCalledWith('bottle_steam');
        expect(guidedLoginCalls.map((c) => c.targetId)).toEqual([
          'host_steam',
          'bottle_steam',
          'bottle_gog',
        ]);
        seqProgress = findVNodes(tree, (n) => n.type === 'progress')[0];
        expect(seqProgress.props.value).toBe(2);
        expect(seqProgress.props.max).toBe(3);
        expect(String(seqProgress.props['aria-valuetext'] || '')).toContain('3 of 3');
        expect(extractVNodeText(findVNodeByTestId(tree, 'sequential-signin-banner'))).toContain(
          '(Skipped)'
        );
        expect(auditWcag22AA(tree)).toEqual([]);

        // Step 3d: Resolve bottle_gog as authenticated -> remaining bottle_steam was explicitly skipped, so Finish Setup is now available!
        pendingGuidedResolvers.get('bottle_gog')!({
          success: true,
          targetId: 'bottle_gog',
          authenticated: true,
          autoClosedClient: true,
          probeState: {
            ...postProvisionSnapshot.clientLogins.bottle_gog,
            authenticated: true,
            accountMatchesOneLauncher: true,
            detectedAccountLabel: 'SyntheticGog42',
            statusSummary: 'Signed in as SyntheticGog42',
          },
          message: 'Signed into GOG Galaxy (Windows) as SyntheticGog42.',
        });
        pendingGuidedResolvers.delete('bottle_gog');
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeDefined();

        // Complete the remaining skipped bottle_steam so all 3 installed clients are signed in
        findVNodeByTestId(tree, 'guided-login-btn-bottle_steam').props.onClick();
        await new Promise((r) => setTimeout(r, 0));
        pendingGuidedResolvers.get('bottle_steam')!({
          success: true,
          targetId: 'bottle_steam',
          authenticated: true,
          autoClosedClient: true,
          probeState: {
            ...postProvisionSnapshot.clientLogins.bottle_steam,
            authenticated: true,
            accountMatchesOneLauncher: true,
            detectedAccountLabel: 'TestPlayer42',
            statusSummary: 'Signed in as TestPlayer42',
          },
          message: 'Signed into Steam (Windows) as TestPlayer42.',
        });
        pendingGuidedResolvers.delete('bottle_steam');
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();

        const allSignedInBanner = findVNodeByTestId(tree, 'all-installed-clients-signed-in-banner');
        expect(allSignedInBanner).toBeDefined();
        expect(extractVNodeText(allSignedInBanner)).toContain('All launchers signed in');
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeDefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // 4) Clicking 'Open Steam (Mac)' on already-authenticated host_steam passes forceInteractiveLogin: true
        const verifyHostSteamBtn = findVNodeByTestId(tree, 'guided-login-btn-host_steam');
        expect(extractVNodeText(verifyHostSteamBtn)).toContain('Open Steam (Mac)');
        verifyHostSteamBtn.props.onClick();
        await new Promise((r) => setTimeout(r, 0));

        const lastCall = guidedLoginCalls[guidedLoginCalls.length - 1];
        expect(lastCall).toMatchObject({
          targetId: 'host_steam',
          forceInteractiveLogin: true,
        });
        pendingGuidedResolvers.get('host_steam')!({
          success: true,
          targetId: 'host_steam',
          authenticated: true,
          autoClosedClient: false,
          probeState: environmentSetupService.getLastSnapshot()!.clientLogins.host_steam,
          message: 'Opened Steam (Mac) in foreground to verify or switch accounts.',
        });
        pendingGuidedResolvers.delete('host_steam');
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();
        expect(auditWcag22AA(tree)).toEqual([]);

        // 5) Closing/skipping the wizard while a guided login watcher is active cancels the in-flight watcher immediately
        cancelGuidedSpy.mockClear();
        findVNodeByTestId(tree, 'guided-login-btn-bottle_gog').props.onClick();
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();
        expect(environmentSetupService.getActiveGuidedLoginTarget()).toBe('bottle_gog');

        const dismissBtn =
          findVNodeByTestId(tree, 'setup-skip-btn') || findVNodeByTestId(tree, 'setup-close-btn');
        expect(dismissBtn).toBeDefined();
        dismissBtn.props.onClick();
        await new Promise((r) => setTimeout(r, 0));

        expect(cancelGuidedSpy).toHaveBeenCalledTimes(1);
        expect(cancelGuidedSpy).toHaveBeenCalledWith('bottle_gog');
        expect(environmentSetupService.getActiveGuidedLoginTarget()).toBeNull();
      } finally {
        wizard.unmount();
      }
    });

    it('6.5 eliminates stale "Some setup items were removed (4)" banner upon immediate wizard re-entry without restarting the app and verifies Fix & Match styling parity', async () => {
      const { homedir, userDataDir } = makeIsolatedEnv('ui-immediate-reentry-65');

      // Persist prior setup history where CrossOver, OneLauncher bottle, bottled Steam & bottled GOG were configured
      environmentHealthProber.saveSetupWizardState(
        {
          completedAt: '2026-10-01T10:00:00.000Z',
          preferredRunnerType: 'crossover',
          preferredBottleName: 'OneLauncher',
          configuredComponents: [
            'rosetta2',
            'host_steam',
            'runner_crossover',
            'bottle_default',
            'bottle_steam',
            'bottle_gog',
          ],
        },
        { homedir, userDataDir }
      );

      // Host Steam + Rosetta are installed; the 4 Windows-on-Mac items were removed prior to opening the wizard
      const hostSteamApp = path.join(homedir, 'Applications', 'Steam.app');
      fs.mkdirSync(path.join(hostSteamApp, 'Contents', 'MacOS'), { recursive: true });
      fs.writeFileSync(path.join(hostSteamApp, 'Contents', 'MacOS', 'steam_osx'), '#!/bin/sh\n');
      fs.mkdirSync(path.join(homedir, 'Library/Application Support/Steam/config'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(homedir, 'Library/Application Support/Steam/config/loginusers.vdf'),
        `"users"\n{\n  "76561198000000042"\n  {\n    "AccountName" "testplayer42"\n    "PersonaName" "TestPlayer42"\n    "RememberPassword" "1"\n    "AllowAutoLogin" "1"\n    "MostRecent" "1"\n    "Timestamp" "1700000100"\n  }\n}\n`
      );

      const initialDriftedSnap: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: true,
          savedTokens: {
            steam: { steamId: '76561198000000042' },
            gog: { user_id: '48800000000000042', username: 'SyntheticGog42' },
          },
          connectedStorefronts: ['steam', 'gog'],
        });

      expect(initialDriftedSnap.counts.removedSinceLastSetupCount).toBe(4);

      let filesystemProvisioned = false;
      let persistedState = environmentHealthProber.getSetupWizardState({ homedir, userDataDir });

      // Simulate an overlapping slow pre-setup probe alongside fresh post-setup probes
      let slowStaleProbeResolver: ((snap: EnvironmentHealthSnapshot) => void) | null = null;
      let triggerSlowProbeOnce = false;

      const probeSpy = vi.fn(async () => {
        if (triggerSlowProbeOnce) {
          triggerSlowProbeOnce = false;
          return await new Promise<EnvironmentHealthSnapshot>((resolve) => {
            slowStaleProbeResolver = resolve;
          });
        }
        return await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          rosettaInstalled: true,
          savedTokens: {
            steam: { steamId: '76561198000000042' },
            gog: { user_id: '48800000000000042', username: 'SyntheticGog42' },
          },
          connectedStorefronts: ['steam', 'gog'],
        });
      });

      const runSetupSpy = vi.fn(async () => {
        // Materialize CrossOver.app + OneLauncher bottle + Steam.exe + GalaxyClient.exe on disk
        const coWine = path.join(
          homedir,
          'Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'
        );
        fs.mkdirSync(path.dirname(coWine), { recursive: true });
        fs.writeFileSync(coWine, '#!/bin/sh\n');
        const bottleRoot = path.join(
          homedir,
          'Library/Application Support/CrossOver/Bottles/OneLauncher'
        );
        const steamExe = path.join(bottleRoot, 'drive_c/Program Files (x86)/Steam/steam.exe');
        const gogExe = path.join(
          bottleRoot,
          'drive_c/Program Files (x86)/GOG Galaxy/GalaxyClient.exe'
        );
        fs.mkdirSync(path.dirname(steamExe), { recursive: true });
        fs.mkdirSync(path.dirname(gogExe), { recursive: true });
        fs.mkdirSync(path.join(bottleRoot, 'drive_c/windows/system32'), { recursive: true });
        fs.writeFileSync(path.join(bottleRoot, 'system.reg'), 'WINE REGISTRY Version 2\n');
        fs.writeFileSync(steamExe, 'MZ');
        fs.writeFileSync(gogExe, 'MZ');
        filesystemProvisioned = true;

        // Intentionally omit snapshot on result (`snapshot: {} as any`) to verify service-level reconciliation + forceFresh re-probe!
        return {
          success: true,
          runId: 'reentry-run-65',
          outcomes: [
            { componentId: 'runner_crossover', action: 'install_runner', status: 'completed', message: 'Installed' },
            { componentId: 'bottle_default', action: 'ensure_bottle', status: 'completed', message: 'Created' },
            { componentId: 'bottle_steam', action: 'install_client', status: 'completed', message: 'Installed' },
            { componentId: 'bottle_gog', action: 'install_client', status: 'completed', message: 'Installed' },
          ],
          snapshot: {} as any,
        } satisfies RunEnvironmentSetupResult;
      });

      const guidedLoginSpy = vi.fn(async (req: StartGuidedClientLoginRequest) => {
        const bottleRoot = path.join(
          homedir,
          'Library/Application Support/CrossOver/Bottles/OneLauncher'
        );
        if (req.targetId === 'bottle_steam') {
          const cfgDir = path.join(bottleRoot, 'drive_c/Program Files (x86)/Steam/config');
          fs.mkdirSync(cfgDir, { recursive: true });
          fs.writeFileSync(
            path.join(cfgDir, 'loginusers.vdf'),
            `"users"\n{\n  "76561198000000042"\n  {\n    "AccountName" "testplayer42"\n    "PersonaName" "TestPlayer42"\n    "RememberPassword" "1"\n    "AllowAutoLogin" "1"\n    "MostRecent" "1"\n    "Timestamp" "1700000200"\n  }\n}\n`
          );
        } else if (req.targetId === 'bottle_gog') {
          fs.writeFileSync(
            path.join(bottleRoot, 'user.reg'),
            `[Software\\\\GOG.com\\\\Galaxy]\n"refreshToken"="valid_session_marker"\n\n[Software\\\\GOG.com\\\\Galaxy\\\\settings]\n"userId"="48800000000000042"\n"username"="SyntheticGog42"\n`
          );
        }
        const states = await environmentHealthProber.probeClientLoginStates({
          platform: 'darwin',
          homedir,
          userDataDir,
          connectedStorefronts: ['steam', 'gog'],
          savedTokens: {
            steam: { steamId: '76561198000000042' },
            gog: { user_id: '48800000000000042', username: 'SyntheticGog42' },
          },
        });
        return {
          success: true,
          targetId: req.targetId,
          authenticated: true,
          autoClosedClient: true,
          probeState: states[req.targetId],
          message: 'Signed in.',
        } satisfies GuidedClientLoginResult;
      });

      (globalThis as any).window.electronAPI = {
        platform: 'darwin',
        arch: 'arm64',
        openExternal: vi.fn(),
        probeEnvironmentHealth: probeSpy,
        getSetupWizardState: vi.fn(async () => persistedState),
        saveSetupWizardState: vi.fn(async (patch: any) => {
          persistedState = environmentHealthProber.saveSetupWizardState(patch, {
            homedir,
            userDataDir,
          });
          return { success: true, state: persistedState };
        }),
        startGuidedClientLogin: guidedLoginSpy,
        cancelGuidedClientLogin: vi.fn(async () => ({ success: true, cancelled: true })),
        runEnvironmentSetupTasks: runSetupSpy,
        cancelEnvironmentSetup: vi.fn(async () => ({ success: true, cancelled: true })),
        onEnvironmentSetupProgress: vi.fn(() => () => {}),
      };

      const onCloseFirst = vi.fn();
      const firstWizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        connectedStorefronts: ['steam', 'gog'],
        onClose: onCloseFirst,
      });

      try {
        let tree = firstWizard.render();
        await new Promise((r) => setTimeout(r, 25));
        tree = firstWizard.render();

        // Initially shows the 4 removed items banner + Fix & Match outer container styling
        const banner = findVNodeByTestId(tree, 'removed-components-banner');
        expect(banner).toBeDefined();
        expect(extractVNodeText(banner)).toContain('Some setup items were removed (4)');
        expect(extractVNodeText(tree)).toContain('Step 1 of 5');
        expect(auditWcag22AA(tree)).toEqual([]);

        // Click "Reinstall Missing" -> jumps to Step 4 (Install) & queues all 4 items
        findVNodeByTestId(tree, 'repair-removed-components-btn').props.onClick();
        tree = firstWizard.render();
        expect(findVNodeByTestId(tree, 'run-provisioning-btn')).toBeDefined();

        // Run provisioning -> installs all 4 items
        findVNodeByTestId(tree, 'run-provisioning-btn').props.onClick();
        await new Promise((r) => setTimeout(r, 25));
        tree = firstWizard.render();
        expect(filesystemProvisioned).toBe(true);
        expect(findVNodeByTestId(tree, 'removed-components-banner')).toBeUndefined();

        // Advance to Step 5 (Sign In) via Continue/Sign In Now & sign in to both newly installed bottled launchers
        findVNodeByTestId(tree, 'continue-to-guided-signins-btn').props.onClick();
        tree = firstWizard.render();
        findVNodeByTestId(tree, 'start-sequential-signin-btn').props.onClick();
        await new Promise((r) => setTimeout(r, 25));
        tree = firstWizard.render();

        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeDefined();

        // Start an overlapping background probe before clicking Finish Setup to prove forceFresh chaining!
        triggerSlowProbeOnce = true;
        const staleInFlightPromise = environmentSetupService.probeHealth(['steam', 'gog']);

        // Click Finish Setup -> closes modal & triggers forceFresh health probe
        findVNodeByTestId(tree, 'finish-setup-btn').props.onClick();
        expect(onCloseFirst).toHaveBeenCalledTimes(1);

        // Resolve the older slow probe with the OLD drifted snapshot — forceFresh must chain a fresh probe right after it!
        expect(slowStaleProbeResolver).not.toBeNull();
        slowStaleProbeResolver!(initialDriftedSnap);
        await staleInFlightPromise;
      } finally {
        firstWizard.unmount();
      }

      // Immediately re-open Setup Wizard WITHOUT quitting/restarting One Launcher!
      const secondWizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        connectedStorefronts: ['steam', 'gog'],
        onClose: vi.fn(),
      });

      try {
        let reenteredTree = secondWizard.render();
        await new Promise((r) => setTimeout(r, 30));
        reenteredTree = secondWizard.render();

        // Regression assertion: ZERO false "Some setup items were removed" banner on immediate re-entry!
        expect(findVNodeByTestId(reenteredTree, 'removed-components-banner')).toBeUndefined();
        const latestSnap = environmentSetupService.getLastSnapshot()!;
        expect(latestSnap.counts.removedSinceLastSetupCount).toBe(0);
        expect(latestSnap.components.runner_crossover.status).toBe('ready');
        expect(latestSnap.components.bottle_default.status).toBe('ready');
        expect(latestSnap.components.bottle_steam.status).toBe('ready');
        expect(latestSnap.components.bottle_gog.status).toBe('ready');
        expect(auditWcag22AA(reenteredTree)).toEqual([]);
      } finally {
        secondWizard.unmount();
      }
    });

    it('6.6 dynamically adapts Setup Wizard steps, options, and copy to Windows Native (win32 x64) and Intel Mac (darwin x64) with zero cross-OS leakage and 0 WCAG 2.2 AA violations', async () => {
      // --- Part A: Windows Native (win32 x64) ---
      const winEnv = makeIsolatedEnv('ui-dynamic-win32-66a');
      const winSnap: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'win32',
          arch: 'x64',
          homedir: winEnv.homedir,
          userDataDir: winEnv.userDataDir,
          vcRedistInstalled: false,
          webview2Installed: true,
          gamingServicesInstalled: false,
          savedTokens: { steam: { steamId: '76561198000000042' } },
          connectedStorefronts: ['steam', 'xbox'],
        });

      (globalThis as any).window.electronAPI = {
        platform: 'win32',
        arch: 'x64',
        openExternal: vi.fn(),
        probeEnvironmentHealth: vi.fn(async () => winSnap),
        getSetupWizardState: vi.fn(async () => createDefaultSetupWizardState()),
        saveSetupWizardState: vi.fn(async (patch: any) => ({
          success: true,
          state: { ...createDefaultSetupWizardState(), ...patch },
        })),
        startGuidedClientLogin: vi.fn(),
        cancelGuidedClientLogin: vi.fn(async () => ({ success: true, cancelled: true })),
        runEnvironmentSetupTasks: vi.fn(),
        cancelEnvironmentSetup: vi.fn(async () => ({ success: true, cancelled: true })),
        onEnvironmentSetupProgress: vi.fn(() => () => {}),
      };

      await environmentSetupService.probeHealth(['steam', 'xbox'], { forceFresh: true });

      // Even if a caller passes initialStep: 'compatibility' on Windows, it safely clamps to 'prerequisites'!
      const winWizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'first_launch',
        initialStep: 'compatibility',
        connectedStorefronts: ['steam', 'xbox'],
        onClose: vi.fn(),
      });

      try {
        let tree = winWizard.render();
        await new Promise((r) => setTimeout(r, 5));
        tree = winWizard.render();

        // 1) Stepper has ONLY 5 steps on Windows (no "3. Windows Games" / compatibility tab)
        expect(findVNodeByTestId(tree, 'setup-step-tab-compatibility')).toBeUndefined();
        expect(findVNodeByTestId(tree, 'setup-step-tab-prerequisites')).toBeDefined();
        expect(findVNodeByTestId(tree, 'setup-step-tab-accounts')).toBeDefined();
        expect(extractVNodeText(findVNodeByTestId(tree, 'setup-step-tab-clients'))).toBe(
          '3. Launchers'
        );
        expect(extractVNodeText(findVNodeByTestId(tree, 'setup-step-tab-summary'))).toBe(
          '4. Install'
        );
        expect(extractVNodeText(findVNodeByTestId(tree, 'setup-step-tab-client_logins'))).toBe(
          '5. Sign In'
        );
        expect(extractVNodeText(tree)).toContain('Windows PC');
        expect(extractVNodeText(tree)).toContain('Step 1 of 5');

        // 2) Progressively walk every Windows step via Next and assert ZERO Bottle / CrossOver / Rosetta / Mac copy leaks
        const winStepIds: SetupWizardStepId[] = [
          'prerequisites',
          'accounts',
          'clients',
          'summary',
          'client_logins',
        ];
        for (let idx = 0; idx < winStepIds.length; idx++) {
          const stepId = winStepIds[idx];
          if (idx > 0) {
            findVNodeByTestId(tree, 'setup-next-step-btn').props.onClick();
            tree = winWizard.render();
          }
          const fullStepText = extractVNodeText(tree);
          expect(fullStepText).not.toContain('Bottle');
          expect(fullStepText).not.toContain('CrossOver');
          expect(fullStepText).not.toContain('Rosetta');
          expect(fullStepText).not.toContain('(Mac)');
          expect(fullStepText).not.toContain('Windows on Mac');
          expect(auditWcag22AA(tree)).toEqual([]);

          if (stepId === 'clients') {
            expect(fullStepText).toContain('Game Launchers');
            expect(findVNodeByTestId(tree, 'setup-client-card-host_steam')).toBeDefined();
            expect(findVNodeByTestId(tree, 'setup-client-card-bottle_steam')).toBeUndefined();
            expect(findVNodeByTestId(tree, 'setup-client-card-xbox_runtime')).toBeDefined();
          }

          if (stepId === 'summary') {
            expect(fullStepText).toContain('System Components');
            expect(findVNodeByTestId(tree, 'planned-task-win_vcredist-install_win_vcredist')).toBeDefined();
            expect(findVNodeByTestId(tree, 'planned-task-host_steam-install_client')).toBeDefined();
          }

          if (stepId === 'client_logins') {
            // Uninstalled selected Steam launcher points dynamically to Step 4 (not Step 5!) on Windows
            const hint = findVNodeByTestId(tree, 'queued-uninstalled-clients-hint');
            expect(hint).toBeDefined();
            expect(extractVNodeText(hint)).toContain('Step 4');
            expect(extractVNodeText(hint)).not.toContain('Step 5');
          }
        }
      } finally {
        winWizard.unmount();
      }

      // --- Part B: Intel Mac (darwin x64) ---
      const intelMacEnv = makeIsolatedEnv('ui-dynamic-intel-mac-66b');
      const intelMacSnap: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'x64',
          homedir: intelMacEnv.homedir,
          userDataDir: intelMacEnv.userDataDir,
          savedTokens: {},
          connectedStorefronts: [],
        });

      expect(intelMacSnap.isAppleSiliconMac).toBe(false);
      expect(intelMacSnap.components.rosetta2.status).toBe('not_applicable');
      expect(intelMacSnap.components.runner_gptk.status).toBe('not_applicable');

      (globalThis as any).window.electronAPI = {
        platform: 'darwin',
        arch: 'x64',
        openExternal: vi.fn(),
        probeEnvironmentHealth: vi.fn(async () => intelMacSnap),
        getSetupWizardState: vi.fn(async () => createDefaultSetupWizardState()),
        saveSetupWizardState: vi.fn(async (patch: any) => ({
          success: true,
          state: { ...createDefaultSetupWizardState(), ...patch },
        })),
        startGuidedClientLogin: vi.fn(),
        cancelGuidedClientLogin: vi.fn(async () => ({ success: true, cancelled: true })),
        runEnvironmentSetupTasks: vi.fn(),
        cancelEnvironmentSetup: vi.fn(async () => ({ success: true, cancelled: true })),
        onEnvironmentSetupProgress: vi.fn(() => () => {}),
      };

      await environmentSetupService.probeHealth([], { forceFresh: true });

      const intelMacWizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'first_launch',
        connectedStorefronts: [],
        onClose: vi.fn(),
      });

      try {
        let tree = intelMacWizard.render();
        await new Promise((r) => setTimeout(r, 5));
        tree = intelMacWizard.render();

        expect(extractVNodeText(tree)).toContain('macOS • Intel');
        expect(extractVNodeText(tree)).toContain('Step 1 of 5');
        expect(findVNodeByTestId(tree, 'setup-step-tab-prerequisites')).toBeUndefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // Advance to Step 2 (Windows Games on Intel Mac): Apple Game Porting Toolkit (arm64-only) is omitted!
        findVNodeByTestId(tree, 'setup-next-step-btn').props.onClick();
        tree = intelMacWizard.render();
        expect(findVNodeByTestId(tree, 'setup-runner-crossover')).toBeDefined();
        expect(findVNodeByTestId(tree, 'setup-runner-wine')).toBeDefined();
        expect(findVNodeByTestId(tree, 'setup-runner-gptk')).toBeUndefined();
        expect(findVNodeByTestId(tree, 'setup-runner-skip')).toBeDefined();
        expect(auditWcag22AA(tree)).toEqual([]);
      } finally {
        intelMacWizard.unmount();
      }
    });

    it('6.7 verifies background Rosetta 2 auto-install, Fix & Match greyed-out stepper progression, Installed vs Not Installed compatibility badges, and live Needs Sign-In -> Signed In launcher movement', async () => {
      // --- Part 1: Background Rosetta 2 Auto-Check & Install on macOS Apple Silicon ---
      const bgEnv = makeIsolatedEnv('bg-rosetta-67');
      const spawnedSoftwareUpdateArgs: string[][] = [];
      const mockExecFile = vi.fn((bin: string, args: string[], _opts: any, cb?: any) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        if (bin === '/usr/sbin/softwareupdate') {
          spawnedSoftwareUpdateArgs.push(args);
          const rosettaMarker = path.join(
            bgEnv.homedir,
            'Library/Apple/usr/libexec/oah/libRosettaRuntime'
          );
          fs.mkdirSync(path.dirname(rosettaMarker), { recursive: true });
          fs.writeFileSync(rosettaMarker, 'rosetta');
        }
        callback?.(null, 'Install of Rosetta 2 finished successfully', '');
      });

      // a) No-op on Intel Mac (x64) and Windows (win32)
      const intelRes = await environmentProvisioner.ensureRosetta2InBackground({
        platform: 'darwin',
        arch: 'x64',
        homedir: bgEnv.homedir,
        userDataDir: bgEnv.userDataDir,
        execFileImpl: mockExecFile,
      });
      expect(intelRes).toEqual({ installed: false, alreadyReady: true });
      const winRes = await environmentProvisioner.ensureRosetta2InBackground({
        platform: 'win32',
        arch: 'x64',
        homedir: bgEnv.homedir,
        userDataDir: bgEnv.userDataDir,
        execFileImpl: mockExecFile,
      });
      expect(winRes).toEqual({ installed: false, alreadyReady: true });
      expect(spawnedSoftwareUpdateArgs).toHaveLength(0);

      // b) Missing on Apple Silicon Mac (darwin arm64) -> installs automatically in background
      const armInstallRes = await environmentProvisioner.ensureRosetta2InBackground({
        platform: 'darwin',
        arch: 'arm64',
        homedir: bgEnv.homedir,
        userDataDir: bgEnv.userDataDir,
        execFileImpl: mockExecFile,
      });
      expect(armInstallRes).toEqual({ installed: true, alreadyReady: false });
      expect(spawnedSoftwareUpdateArgs).toEqual([['--install-rosetta', '--agree-to-license']]);
      expect(
        environmentHealthProber.getSetupWizardState({
          homedir: bgEnv.homedir,
          userDataDir: bgEnv.userDataDir,
        }).configuredComponents
      ).toContain('rosetta2');

      // c) Subsequent check on Apple Silicon Mac sees Rosetta 2 ready -> 0 extra spawns
      const armAlreadyReadyRes = await environmentProvisioner.ensureRosetta2InBackground({
        platform: 'darwin',
        arch: 'arm64',
        homedir: bgEnv.homedir,
        userDataDir: bgEnv.userDataDir,
        execFileImpl: mockExecFile,
      });
      expect(armAlreadyReadyRes).toEqual({ installed: true, alreadyReady: true });
      expect(spawnedSoftwareUpdateArgs).toHaveLength(1);

      // --- Part 2: Stepper Greyed-Out Progression, Compatibility Installed/Not Installed Clarity & Live Sign-In Section Move ---
      const uiEnv = makeIsolatedEnv('ui-changes-67');
      seedMockCrossOverApp(path.join(uiEnv.homedir, 'Applications'), '26.0.0');
      const hostSteamBin = path.join(
        uiEnv.homedir,
        'Applications/Steam.app/Contents/MacOS/steam_osx'
      );
      fs.mkdirSync(path.dirname(hostSteamBin), { recursive: true });
      fs.writeFileSync(hostSteamBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.mkdirSync(path.join(uiEnv.homedir, 'Library/Application Support/Steam/config'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(uiEnv.homedir, 'Library/Application Support/Steam/config/loginusers.vdf'),
        buildSteamLoginUsersVdf([
          {
            steamId64: SYNTHETIC_STEAM_ID_PRIMARY,
            accountName: 'testplayer42',
            personaName: 'TestPlayer42',
            mostRecent: true,
            allowAutoLogin: true,
          },
        ]),
        'utf8'
      );

      // Seed OneLauncher bottle with unsigned bottled Steam and unsigned bottled GOG
      seedInitializedCrossOverBottle(uiEnv.homedir, 'OneLauncher', {
        withSteam: true,
        withGogGalaxy: true,
      });

      const snap: EnvironmentHealthSnapshot =
        await environmentHealthProber.probeEnvironmentHealth({
          platform: 'darwin',
          arch: 'arm64',
          homedir: uiEnv.homedir,
          userDataDir: uiEnv.userDataDir,
          rosettaInstalled: true,
          connectedStorefronts: ['steam', 'gog'],
          savedTokens: {
            steam: { steamId: SYNTHETIC_STEAM_ID_PRIMARY },
            gog: { access_token: 'gog_tok_67', user_id: SYNTHETIC_GOG_USER_ID_PRIMARY },
          },
        });

      // Verify baseline: host_steam is signed in; bottle_steam & bottle_gog are installed & NOT signed in
      expect(snap.clientLogins.host_steam.authenticated).toBe(true);
      expect(snap.clientLogins.bottle_steam.installed).toBe(true);
      expect(snap.clientLogins.bottle_steam.authenticated).toBe(false);
      expect(snap.clientLogins.bottle_gog.installed).toBe(true);
      expect(snap.clientLogins.bottle_gog.authenticated).toBe(false);

      const pendingResolvers = new Map<
        ClientLoginTargetId,
        (res: GuidedClientLoginResult) => void
      >();

      (globalThis as any).window.electronAPI = {
        platform: 'darwin',
        arch: 'arm64',
        openExternal: vi.fn(),
        probeEnvironmentHealth: vi.fn(async () => snap),
        getSetupWizardState: vi.fn(async () => ({
          ...createDefaultSetupWizardState(),
          preferredRunnerType: 'crossover',
          preferredBottleName: 'OneLauncher',
        })),
        saveSetupWizardState: vi.fn(async (patch: any) => ({
          success: true,
          state: { ...createDefaultSetupWizardState(), ...patch },
        })),
        startGuidedClientLogin: vi.fn(
          (req: StartGuidedClientLoginRequest) =>
            new Promise<GuidedClientLoginResult>((resolve) => {
              pendingResolvers.set(req.targetId, resolve);
            })
        ),
        cancelGuidedClientLogin: vi.fn(async () => ({ success: true, cancelled: true })),
        runEnvironmentSetupTasks: vi.fn(),
        cancelEnvironmentSetup: vi.fn(async () => ({ success: true, cancelled: true })),
        onEnvironmentSetupProgress: vi.fn(() => () => {}),
      };

      await environmentSetupService.loadWizardState();
      await environmentSetupService.probeHealth(['steam', 'gog'], { forceFresh: true });

      const wizard = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        mode: 'health_check',
        connectedStorefronts: ['steam', 'gog'],
        onClose: vi.fn(),
      });

      try {
        let tree = wizard.render();
        await new Promise((r) => setTimeout(r, 10));
        tree = wizard.render();

        // A) Change 1 & Change 2: Step 1 is 1. Accounts (no prerequisites tab), and Steps 2-5 start greyed out & disabled!
        expect(findVNodeByTestId(tree, 'setup-step-tab-prerequisites')).toBeUndefined();
        const step1Tab = findVNodeByTestId(tree, 'setup-step-tab-accounts');
        const step2Tab = findVNodeByTestId(tree, 'setup-step-tab-compatibility');
        const step3Tab = findVNodeByTestId(tree, 'setup-step-tab-clients');
        const step4Tab = findVNodeByTestId(tree, 'setup-step-tab-summary');
        const step5Tab = findVNodeByTestId(tree, 'setup-step-tab-client_logins');

        expect(step1Tab.props.disabled).toBe(false);
        expect(String(step1Tab.props.className)).toContain('bg-[#66c0f4]');
        for (const unprogressedTab of [step2Tab, step3Tab, step4Tab, step5Tab]) {
          expect(unprogressedTab.props.disabled).toBe(true);
          expect(String(unprogressedTab.props.className)).toContain('text-slate-600');
          expect(String(unprogressedTab.props.className)).toContain('opacity-50');
          expect(String(unprogressedTab.props.className)).toContain('cursor-not-allowed');
        }
        expect(auditWcag22AA(tree)).toEqual([]);

        // B) Advance to Step 2 (2. Windows Games) -> Step 2 activates, Step 1 stays unlocked ('text-slate-300'), Steps 3-5 remain greyed out
        findVNodeByTestId(tree, 'setup-next-step-btn').props.onClick();
        tree = wizard.render();
        expect(findVNodeByTestId(tree, 'setup-step-tab-accounts').props.disabled).toBe(false);
        expect(String(findVNodeByTestId(tree, 'setup-step-tab-accounts').props.className)).toContain(
          'text-slate-300'
        );
        expect(findVNodeByTestId(tree, 'setup-step-tab-clients').props.disabled).toBe(true);

        // C) Change 3: Windows Game Support on Mac clearly distinguishes Installed vs Not Installed layers
        const compatSummary = findVNodeByTestId(tree, 'compat-installed-summary');
        expect(extractVNodeText(compatSummary)).toContain('Installed on this Mac: CrossOver');
        expect(
          extractVNodeText(findVNodeByTestId(tree, 'runner-install-status-crossover'))
        ).toBe('Installed');
        expect(extractVNodeText(findVNodeByTestId(tree, 'runner-install-status-wine'))).toBe(
          'Not Installed'
        );
        expect(extractVNodeText(findVNodeByTestId(tree, 'runner-install-status-gptk'))).toBe(
          'Not Installed'
        );
        expect(auditWcag22AA(tree)).toEqual([]);

        // Advance through Step 3 -> Step 4 -> Step 5 (Sign In)
        findVNodeByTestId(tree, 'setup-next-step-btn').props.onClick();
        tree = wizard.render();
        findVNodeByTestId(tree, 'setup-next-step-btn').props.onClick();
        tree = wizard.render();
        findVNodeByTestId(tree, 'setup-next-step-btn').props.onClick();
        tree = wizard.render();

        // D) Change 4: Installed Launchers separated into Needs Sign-In (2) and Signed In (1)
        let needsSignInSection = findVNodeByTestId(tree, 'needs-signin-launchers-section');
        let signedInSection = findVNodeByTestId(tree, 'signed-in-launchers-section');
        expect(needsSignInSection).toBeDefined();
        expect(signedInSection).toBeDefined();
        expect(extractVNodeText(needsSignInSection)).toContain('Needs Sign-In (2)');
        expect(extractVNodeText(signedInSection)).toContain('Signed In (1)');

        // Verify bottle_steam & bottle_gog are inside Needs Sign-In, while host_steam is inside Signed In
        expect(findVNodeByTestId(needsSignInSection, 'guided-login-card-bottle_steam')).toBeDefined();
        expect(findVNodeByTestId(needsSignInSection, 'guided-login-card-bottle_gog')).toBeDefined();
        expect(findVNodeByTestId(needsSignInSection, 'guided-login-card-host_steam')).toBeUndefined();
        expect(findVNodeByTestId(signedInSection, 'guided-login-card-host_steam')).toBeDefined();
        expect(findVNodeByTestId(signedInSection, 'guided-login-card-bottle_steam')).toBeUndefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // E) Sign in to bottle_steam -> immediately moves from Needs Sign-In into Signed In!
        findVNodeByTestId(tree, 'guided-login-btn-bottle_steam').props.onClick();
        await new Promise((r) => setTimeout(r, 0));
        pendingResolvers.get('bottle_steam')!({
          success: true,
          targetId: 'bottle_steam',
          authenticated: true,
          autoClosedClient: true,
          probeState: {
            ...snap.clientLogins.bottle_steam,
            authenticated: true,
            accountMatchesOneLauncher: true,
            detectedAccountLabel: 'TestPlayer42',
            statusSummary: 'Signed in as TestPlayer42',
          },
          message: 'Signed into Steam (Windows) as TestPlayer42.',
        });
        pendingResolvers.delete('bottle_steam');
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();

        needsSignInSection = findVNodeByTestId(tree, 'needs-signin-launchers-section');
        signedInSection = findVNodeByTestId(tree, 'signed-in-launchers-section');
        expect(extractVNodeText(needsSignInSection)).toContain('Needs Sign-In (1)');
        expect(extractVNodeText(signedInSection)).toContain('Signed In (2)');
        expect(findVNodeByTestId(needsSignInSection, 'guided-login-card-bottle_steam')).toBeUndefined();
        expect(findVNodeByTestId(signedInSection, 'guided-login-card-bottle_steam')).toBeDefined();
        expect(findVNodeByTestId(needsSignInSection, 'guided-login-card-bottle_gog')).toBeDefined();
        expect(auditWcag22AA(tree)).toEqual([]);

        // F) Sign in to remaining bottle_gog -> Needs Sign-In section disappears & Signed In (3) holds all 3!
        findVNodeByTestId(tree, 'guided-login-btn-bottle_gog').props.onClick();
        await new Promise((r) => setTimeout(r, 0));
        pendingResolvers.get('bottle_gog')!({
          success: true,
          targetId: 'bottle_gog',
          authenticated: true,
          autoClosedClient: true,
          probeState: {
            ...snap.clientLogins.bottle_gog,
            authenticated: true,
            accountMatchesOneLauncher: true,
            detectedAccountLabel: 'SyntheticGog42',
            statusSummary: 'Signed in as SyntheticGog42',
          },
          message: 'Signed into GOG Galaxy (Windows) as SyntheticGog42.',
        });
        pendingResolvers.delete('bottle_gog');
        await new Promise((r) => setTimeout(r, 0));
        tree = wizard.render();

        expect(findVNodeByTestId(tree, 'needs-signin-launchers-section')).toBeUndefined();
        signedInSection = findVNodeByTestId(tree, 'signed-in-launchers-section');
        expect(extractVNodeText(signedInSection)).toContain('Signed In (3)');
        expect(findVNodeByTestId(signedInSection, 'guided-login-card-host_steam')).toBeDefined();
        expect(findVNodeByTestId(signedInSection, 'guided-login-card-bottle_steam')).toBeDefined();
        expect(findVNodeByTestId(signedInSection, 'guided-login-card-bottle_gog')).toBeDefined();
        expect(findVNodeByTestId(tree, 'finish-setup-btn')).toBeDefined();
        expect(auditWcag22AA(tree)).toEqual([]);
      } finally {
        wizard.unmount();
      }
    });
  });
});
