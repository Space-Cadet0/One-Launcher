import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';

import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  type ActiveGameSession,
  type BottleDisplayScalingMode,
  type CompatibilityLayerInfo,
  type DisplayAspectRatioMode,
  type GameLaunchConfig,
  type GlobalBottleDisplayScalingMode,
  type GlobalDisplayAspectRatioMode,
  type LauncherPerformanceSettings,
  type ResolvedLaunchModePreview,
  type StorefrontLaunchProfile,
} from '../src/contracts/launcher';
import type { CanonicalGame } from '../src/contracts/game';
import {
  extractStorefrontProfile,
  sanitizeGameLaunchConfig,
  sanitizePerformanceSettings,
} from '../src/services/launcher/launchConfigStore';
import { launcherService } from '../src/services/launcher/launcherService';
import { CompatibilityLayerSection } from '../src/components/Launcher/LaunchConfig/CompatibilityLayerSection';
import { VIRTUAL_DESKTOP_RESOLUTION_OPTIONS } from '../src/components/Launcher/LaunchConfig/launchConfigHelpers';
import { StorefrontLifecycleSection } from '../src/components/Launcher/LaunchConfig/StorefrontLifecycleSection';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { createDomain12DeepRenderer } from './helpers/xboxTestHarness';

const requireCjs = createRequire(import.meta.url);

const buildDisplayScaler = requireCjs('../scripts/build-display-scaler.cjs') as {
  MAX_BINARY_SIZE_BYTES: number;
  EXPECTED_SCALER_EXPORTS: string[];
  verifyDisplayScalerBinaries: () => {
    manifestPath: string;
    scalerX86: Record<string, any>;
    scalerX64: Record<string, any>;
    launcherX86: Record<string, any>;
    launcherX64: Record<string, any>;
  };
};

const afterPack = requireCjs('../build/afterPack.cjs') as {
  _testHelpers: {
    KEEP_CROSSOVER_BRIDGE_DLLS: Set<string>;
    KEEP_DARWIN_BOTTLE_HELPER_EXES: Set<string>;
    MACOS_ONLY_BOTTLE_DISPLAY_ASSETS: Set<string>;
    pruneUnpackedCrossOsAssets: (
      unpackedDir: string,
      platformName: string
    ) => { removedCount: number; reclaimedBytes: number };
  };
};

const engineStateRegistry = requireCjs('../electron/launcher/engineStateRegistry.cjs') as {
  LAUNCH_PROFILE_KEYS: string[];
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS: Record<string, unknown>;
  saveGameLaunchConfig: (
    config: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Record<string, any>;
  getGameLaunchConfig: (
    gameId: string,
    platformId?: string,
    options?: Record<string, unknown>
  ) => Record<string, any>;
  getGameLaunchConfigs: (options?: Record<string, unknown>) => Record<string, any>;
  resolvePlatformLaunchConfig: (
    rawConfig: Record<string, unknown>,
    platformId?: string
  ) => Record<string, any>;
  getLauncherPerformanceSettings: (options?: Record<string, unknown>) => Record<string, any>;
  saveLauncherPerformanceSettings: (
    settings: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Record<string, any>;
  onSessionUpdated: (listener: (ev: Record<string, any>) => void) => () => void;
};

const securityAndPathUtils = requireCjs('../electron/launcher/securityAndPathUtils.cjs') as {
  sanitizeLauncherSettingsPayload: (raw: unknown) => Record<string, any>;
};

const binaryInspectors = requireCjs('../electron/launcher/binaryAndManifestInspectors.cjs') as {
  inspectWindowsExecutableHeader: (
    filePath: string,
    options?: Record<string, unknown>
  ) => Record<string, any>;
  inspectPeCapabilities: (
    exePath: string,
    options?: Record<string, unknown>
  ) => Record<string, any>;
  resolveEffectiveGameExecutableCapabilities: (
    exePath: string,
    installDir?: string,
    options?: Record<string, unknown>
  ) => Record<string, any>;
};

const macNativeInstaller = requireCjs(
  '../electron/launcher/macNativeInstallerAndCodesign.cjs'
) as {
  applyCrossOverPerGameSettings: (
    layerOrBottle: string | Record<string, unknown>,
    cfgOrExe?: string | Record<string, unknown>,
    envOrCfg?: Record<string, unknown>,
    bottleOrOpts?: string | Record<string, unknown>,
    maybeOpts?: Record<string, unknown>
  ) => Record<string, string>;
  sanitizeWinePrefixDisplayConfigs: (
    winePrefix: string,
    options?: Record<string, unknown>
  ) => {
    sanitizedFiles: Array<Record<string, any>>;
    maxWidth: number;
    maxHeight: number;
  };
  normalizeDosboxDisplayConfigs: (
    installDir: string,
    options?: Record<string, unknown>
  ) => {
    updatedFiles: Array<{ filePath: string }>;
  };
  getHostMaxDisplayResolution: (
    highResolutionMode?: boolean,
    options?: Record<string, unknown>
  ) => {
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
    logicalWidth: number;
    logicalHeight: number;
    panelWidth: number;
    panelHeight: number;
  };
  prepareCrossOverWineSpawnEnv: (
    wineBinaryPath: string,
    env?: Record<string, string>,
    options?: Record<string, unknown>
  ) => string;
  ensureMacAppCodeSignatureValid: (
    targetPath: string,
    options?: Record<string, unknown>
  ) => Record<string, any>;
  ensureMacAppCodeSignatureValidAsync: (
    targetPath: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, any>>;
};

const verifyDisplayOutput = requireCjs('../scripts/verify-display-output.cjs') as {
  detectDisplayGeometry: (options?: Record<string, unknown>) => {
    width: number;
    height: number;
    logicalWidth: number;
    logicalHeight: number;
    panelWidth: number;
    panelHeight: number;
    name: string;
    isMain: boolean;
  };
};

const supervisor = requireCjs('../electron/launcher/sessionAndProcessSupervisor.cjs') as {
  shouldWrapBottleSessionWithDisplayLauncher: (
    effectiveCaps: Record<string, unknown> | null | undefined,
    effectiveDisplayScalingMode: string,
    launchArgsStr?: string
  ) => boolean;
  stageBottleDisplayScalerBinaries: (
    targetWinePrefix: string,
    options?: Record<string, unknown>
  ) => Record<string, any>;
  launchGame: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, any>>;
  toggleSessionFullscreen: (
    payload?: Record<string, unknown> | string,
    options?: Record<string, unknown>
  ) => Record<string, any>;
  finalizeGameSession: (
    gameId: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, any> | undefined>;
  resetSupervisorStateForTests: () => void;
};

// ----------------------------------------------------------------------------
// Hermetic Temp Directory, Synthetic PE32/PE64 Builder & WCAG 2.2 AA Auditor
// ----------------------------------------------------------------------------

const createdTempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ol-disp-qa-${prefix}-`));
  createdTempDirs.push(dir);
  return dir;
}

interface SyntheticPeSpec {
  arch: 'x86' | 'x64';
  largeAddressAware?: boolean;
  nxCompat?: boolean;
  dynamicBase?: boolean;
  isDll?: boolean;
  importedDlls?: string[];
  rdataStrings?: string[];
}

function buildSyntheticPeBuffer(spec: SyntheticPeSpec): Buffer {
  const buf = Buffer.alloc(0x1400, 0);
  const peOffset = 0x80;
  buf.writeUInt16LE(0x5a4d, 0x00); // 'MZ'
  buf.writeUInt32LE(peOffset, 0x3c); // e_lfanew

  buf.writeUInt32LE(0x00004550, peOffset); // 'PE\0\0'
  const isX64 = spec.arch === 'x64';
  buf.writeUInt16LE(isX64 ? 0x8664 : 0x014c, peOffset + 4);
  buf.writeUInt16LE(1, peOffset + 6); // NumberOfSections = 1

  const optHeaderSize = isX64 ? 0xf0 : 0xe0;
  buf.writeUInt16LE(optHeaderSize, peOffset + 20);
  let characteristics = 0x0002; // IMAGE_FILE_EXECUTABLE_IMAGE
  if (spec.largeAddressAware) characteristics |= 0x0020;
  if (!isX64 && !spec.largeAddressAware) characteristics |= 0x0100;
  if (spec.isDll) characteristics |= 0x2000;
  buf.writeUInt16LE(characteristics, peOffset + 22);

  const optOffset = peOffset + 24;
  buf.writeUInt16LE(isX64 ? 0x020b : 0x010b, optOffset);
  if (isX64) {
    buf.writeBigUInt64LE(0x0000000140000000n, optOffset + 24);
  } else {
    buf.writeUInt32LE(0x00400000, optOffset + 28);
  }

  let dllChars = 0;
  if (spec.dynamicBase ?? true) dllChars |= 0x0040;
  if (spec.nxCompat ?? true) dllChars |= 0x0100;
  buf.writeUInt16LE(dllChars, optOffset + 70);

  const numRvaOffset = optOffset + (isX64 ? 108 : 92);
  buf.writeUInt32LE(16, numRvaOffset);
  const dataDirOffset = optOffset + (isX64 ? 112 : 96);

  const secTableOffset = optOffset + optHeaderSize;
  buf.write('.rdata\0\0', secTableOffset, 'ascii');
  buf.writeUInt32LE(0x1000, secTableOffset + 8); // VirtualSize
  buf.writeUInt32LE(0x1000, secTableOffset + 12); // VirtualAddress
  buf.writeUInt32LE(0x1000, secTableOffset + 16); // SizeOfRawData
  buf.writeUInt32LE(0x0200, secTableOffset + 20); // PointerToRawData
  buf.writeUInt32LE(0x40000040, secTableOffset + 36);

  const rvaToFile = (rva: number): number => 0x0200 + (rva - 0x1000);
  let stringCursorRva = 0x1400;
  const writeAsciiRva = (text: string): number => {
    const rva = stringCursorRva;
    const raw = rvaToFile(rva);
    buf.write(text, raw, 'ascii');
    buf[raw + text.length] = 0;
    stringCursorRva += text.length + 1;
    if (stringCursorRva % 2 !== 0) stringCursorRva += 1;
    return rva;
  };

  const importedDlls = spec.importedDlls || [];
  if (importedDlls.length > 0) {
    const importDirRva = 0x1000;
    const importDirSize = (importedDlls.length + 1) * 20;
    buf.writeUInt32LE(importDirRva, dataDirOffset + 1 * 8);
    buf.writeUInt32LE(importDirSize, dataDirOffset + 1 * 8 + 4);
    for (let i = 0; i < importedDlls.length; i += 1) {
      const nameRva = writeAsciiRva(importedDlls[i]);
      const descFileOff = rvaToFile(importDirRva + i * 20);
      buf.writeUInt32LE(nameRva, descFileOff + 12);
    }
  }

  for (const extraLiteral of spec.rdataStrings || []) {
    writeAsciiRva(extraLiteral);
  }

  return buf;
}

function createSyntheticBottleTree(bottleDir: string, opts?: { winVer?: string; userRegExtra?: string }) {
  fs.mkdirSync(path.join(bottleDir, 'drive_c', 'windows', 'system32'), { recursive: true });
  fs.mkdirSync(path.join(bottleDir, 'drive_c', 'windows', 'syswow64'), { recursive: true });
  fs.mkdirSync(path.join(bottleDir, 'drive_c', 'users', 'crossover', 'Saved Games'), {
    recursive: true,
  });
  const winVer = opts?.winVer || 'win10';
  fs.writeFileSync(
    path.join(bottleDir, 'cxbottle.conf'),
    [
      '[Bottle]',
      '"WineArch" = "win64"',
      '"Template" = "win10_64"',
      `"WindowsVersion" = "${winVer}"`,
      '',
      '[EnvironmentVariables]',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(bottleDir, 'system.reg'),
    'WINE REGISTRY Version 2\n[System\\\\CurrentControlSet\\\\Control]\n"ServicesPipeTimeout"=dword:0000ea60\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(bottleDir, 'user.reg'),
    [
      'WINE REGISTRY Version 2',
      '[Software\\\\Wine]',
      `"Version"="${winVer}"`,
      '',
      '[Software\\\\Wine\\\\Mac Driver]',
      '"RetinaMode"="y"',
      '',
      opts?.userRegExtra || '',
    ].join('\n'),
    'utf8'
  );
}

function createFakeChildProcess(pid = 48120) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    return true;
  });
  child.unref = vi.fn();
  return child;
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
    const testId = props['data-testid']
      ? `[data-testid="${props['data-testid']}"]`
      : props.id
        ? `<${tag}#${props.id}>`
        : `<${tag}>`;

    for (const refAttr of ['aria-labelledby', 'aria-describedby', 'aria-controls'] as const) {
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
          `label-valid-for: <label htmlFor="${props.htmlFor}"> references non-existent control id`
        );
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
      if (
        !/\b(min-h-(?:[6-9]|\d{2,}|\[(?:2[4-9]|[3-9]\d|\d{3,})px\])|h-(?:[6-9]|\d{2,})|p-(?:[2-9]|\d{2,})|py-(?:[2-9]|1\.5|\d{2,})|underline)\b/.test(
          cls
        )
      ) {
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

describe('Universal Bottled Fullscreen, Display Virtualization & Dual-OS Packaging Regression Gate', () => {
  beforeEach(() => {
    supervisor.resetSupervisorStateForTests();
  });

  afterEach(() => {
    supervisor.resetSupervisorStateForTests();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    while (createdTempDirs.length > 0) {
      const dir = createdTempDirs.pop();
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  // --------------------------------------------------------------------------
  // 1. PE32/PE64 Determinism, ABI & Dual-OS afterPack Asset Pruning
  // --------------------------------------------------------------------------
  describe('1. PE32/PE64 Determinism, ABI & Dual-OS afterPack Asset Pruning', () => {
    it('verifies all 4 display scaler PE32/PE64 binaries (<120 KB, subsystem=2, exports, .sha256 sidecars, manifest)', () => {
      const verified = buildDisplayScaler.verifyDisplayScalerBinaries();

      expect(buildDisplayScaler.MAX_BINARY_SIZE_BYTES).toBe(120 * 1024);

      expect(verified.scalerX86.machine).toBe('0x14c');
      expect(verified.scalerX86.sizeBytes).toBeGreaterThan(4096);
      expect(verified.scalerX86.sizeBytes).toBeLessThan(120 * 1024);
      expect(verified.scalerX86.exportedCount).toBe(2);
      expect(verified.scalerX86.exportedNames).toEqual(
        expect.arrayContaining(buildDisplayScaler.EXPECTED_SCALER_EXPORTS)
      );

      expect(verified.scalerX64.machine).toBe('0x8664');
      expect(verified.scalerX64.sizeBytes).toBeGreaterThan(4096);
      expect(verified.scalerX64.sizeBytes).toBeLessThan(120 * 1024);
      expect(verified.scalerX64.exportedCount).toBe(2);
      expect(verified.scalerX64.exportedNames).toEqual(
        expect.arrayContaining(buildDisplayScaler.EXPECTED_SCALER_EXPORTS)
      );

      expect(verified.launcherX86.machine).toBe('0x14c');
      expect(verified.launcherX86.subsystem).toBe(2);
      expect(verified.launcherX86.sizeBytes).toBeLessThan(120 * 1024);

      expect(verified.launcherX64.machine).toBe('0x8664');
      expect(verified.launcherX64.subsystem).toBe(2);
      expect(verified.launcherX64.sizeBytes).toBeLessThan(120 * 1024);
    });

    it('preserves all 4 display scaler binaries on darwin afterPack while pruning them on win32', () => {
      const populateUnpackedFixture = (rootDir: string) => {
        const helpersDir = path.join(rootDir, 'electron', 'helpers');
        const binDir = path.join(helpersDir, 'bin');
        fs.mkdirSync(binDir, { recursive: true });

        const files = [
          'one_display_scaler_x86.dll',
          'one_display_scaler_x86.dll.sha256',
          'one_display_scaler_x64.dll',
          'one_display_scaler_x64.dll.sha256',
          'one_display_launcher_x86.exe',
          'one_display_launcher_x86.exe.sha256',
          'one_display_launcher_x64.exe',
          'one_display_launcher_x64.exe.sha256',
          'display-scaler-manifest.json',
          'one_xgameruntime_bridge.dll',
          'one_xgr_win_launcher.exe',
        ];
        for (const name of files) {
          fs.writeFileSync(path.join(binDir, name), `fixture-${name}`, 'utf8');
        }
        fs.writeFileSync(path.join(helpersDir, 'libone_metal_preload.dylib'), 'MACHO', 'utf8');
        return { binDir, helpersDir };
      };

      const macDir = makeTempDir('afterpack-mac');
      const macPaths = populateUnpackedFixture(macDir);
      afterPack._testHelpers.pruneUnpackedCrossOsAssets(macDir, 'darwin');

      expect(fs.existsSync(path.join(macPaths.binDir, 'one_display_scaler_x86.dll'))).toBe(true);
      expect(fs.existsSync(path.join(macPaths.binDir, 'one_display_scaler_x64.dll'))).toBe(true);
      expect(fs.existsSync(path.join(macPaths.binDir, 'one_display_launcher_x86.exe'))).toBe(true);
      expect(fs.existsSync(path.join(macPaths.binDir, 'one_display_launcher_x64.exe'))).toBe(true);
      expect(fs.existsSync(path.join(macPaths.binDir, 'display-scaler-manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(macPaths.binDir, 'one_xgameruntime_bridge.dll'))).toBe(true);
      expect(fs.existsSync(path.join(macPaths.binDir, 'one_xgr_win_launcher.exe'))).toBe(false);

      const winDir = makeTempDir('afterpack-win');
      const winPaths = populateUnpackedFixture(winDir);
      afterPack._testHelpers.pruneUnpackedCrossOsAssets(winDir, 'win32');

      expect(fs.existsSync(path.join(winPaths.binDir, 'one_display_scaler_x86.dll'))).toBe(false);
      expect(fs.existsSync(path.join(winPaths.binDir, 'one_display_scaler_x64.dll'))).toBe(false);
      expect(fs.existsSync(path.join(winPaths.binDir, 'one_display_launcher_x86.exe'))).toBe(false);
      expect(fs.existsSync(path.join(winPaths.binDir, 'one_display_launcher_x64.exe'))).toBe(false);
      expect(fs.existsSync(path.join(winPaths.binDir, 'display-scaler-manifest.json'))).toBe(false);
      expect(fs.existsSync(path.join(winPaths.binDir, 'one_xgameruntime_bridge.dll'))).toBe(true);
      expect(fs.existsSync(path.join(winPaths.binDir, 'one_xgr_win_launcher.exe'))).toBe(true);
      expect(fs.existsSync(path.join(winPaths.helpersDir, 'libone_metal_preload.dylib'))).toBe(
        false
      );
    });
  });

  // --------------------------------------------------------------------------
  // 2. 1:1 LAUNCH_PROFILE_KEYS & LauncherPerformanceSettings Persistence Parity
  // --------------------------------------------------------------------------
  describe('2. 1:1 LAUNCH_PROFILE_KEYS & LauncherPerformanceSettings Persistence Parity', () => {
    it('maintains 100% key parity across engineStateRegistry.LAUNCH_PROFILE_KEYS, launchConfigStore, and disk reload', () => {
      const userDataDir = makeTempDir('userdata-profile-parity');
      const gameDir = makeTempDir('synth-game-dir');
      const exePath = path.join(gameDir, 'SynthEngine.exe');
      const prefixDir = makeTempDir('synth-prefix-dir');
      fs.writeFileSync(exePath, buildSyntheticPeBuffer({ arch: 'x64' }));

      const fullProfile: Required<StorefrontLaunchProfile> = {
        launchMethod: 'compatibility_layer',
        customExecutablePath: exePath,
        workingDirectory: gameDir,
        launchArguments: '-novid -windowed',
        environmentVariables: { SYNTH_VAR: '1' },
        compatibilityLayer: 'crossover',
        wineBottleName: 'SynthBottle',
        winePrefixPath: prefixDir,
        crossoverGraphicsBackend: 'dxmt',
        crossoverD3DMetalVersion: 'auto',
        crossoverHighResolutionMode: true,
        crossoverDlss: false,
        preferredMaxFrameRate: 120,
        metalfxSpatialUpscaleFactor: 1.5,
        virtualDesktop: false,
        virtualDesktopResolution: '1280x960',
        displayScalingMode: 'force_fullscreen',
        displayAspectRatio: 'integer',
        emulateModeset: false,
        forceLargeAddressAware: true,
        audioBufferClamp: true,
        advertiseAvx: false,
        wineMsync: true,
        wineEsync: false,
        wineDebug: '-all',
        metalHud: false,
        dxvkHud: true,
        preLaunchCommand: 'echo pre',
        postExitCommand: 'echo post',
        inGameLauncherBehavior: 'hide_tray_hibernate',
        storefrontClientLifecycle: 'minimal_keep_running',
      };

      const extracted = extractStorefrontProfile(fullProfile, 'gog');
      expect(new Set(Object.keys(extracted))).toEqual(
        new Set(engineStateRegistry.LAUNCH_PROFILE_KEYS)
      );

      const gogVariant: StorefrontLaunchProfile = {
        ...fullProfile,
        displayScalingMode: 'virtual_desktop',
        displayAspectRatio: 'stretch',
        virtualDesktop: true,
        virtualDesktopResolution: '1024x768',
      };

      const payloadToSave: GameLaunchConfig = {
        gameId: 'synth-game-001',
        preferredPlatformId: 'steam',
        ...fullProfile,
        platformConfigs: {
          steam: fullProfile,
          gog: gogVariant,
        },
      };

      const sanitizedTs = sanitizeGameLaunchConfig(payloadToSave);
      expect(sanitizedTs.displayScalingMode).toBe('force_fullscreen');
      expect(sanitizedTs.displayAspectRatio).toBe('integer');
      expect(sanitizedTs.virtualDesktopResolution).toBe('1280x960');
      expect(sanitizedTs.platformConfigs?.gog?.displayScalingMode).toBe('virtual_desktop');
      expect(sanitizedTs.platformConfigs?.gog?.virtualDesktopResolution).toBe('1024x768');

      const saveRes = engineStateRegistry.saveGameLaunchConfig(
        payloadToSave as unknown as Record<string, unknown>,
        { userDataDir }
      );
      expect(saveRes.success).toBe(true);

      const allReloaded = engineStateRegistry.getGameLaunchConfigs({ userDataDir });
      const rawReloaded = allReloaded['synth-game-001'];
      expect(rawReloaded).toBeDefined();

      const resolvedSteam = engineStateRegistry.resolvePlatformLaunchConfig(rawReloaded, 'steam');
      for (const key of engineStateRegistry.LAUNCH_PROFILE_KEYS) {
        expect(resolvedSteam[key]).toEqual((fullProfile as Record<string, unknown>)[key]);
      }

      const resolvedGog = engineStateRegistry.resolvePlatformLaunchConfig(rawReloaded, 'gog');
      expect(resolvedGog.displayScalingMode).toBe('virtual_desktop');
      expect(resolvedGog.displayAspectRatio).toBe('stretch');
      expect(resolvedGog.virtualDesktop).toBe(true);
      expect(resolvedGog.virtualDesktopResolution).toBe('1024x768');
    });

    it('preserves all 10 LauncherPerformanceSettings keys through IPC sanitizeLauncherSettingsPayload and disk persistence', () => {
      const userDataDir = makeTempDir('userdata-perf-ipc');
      const incomingIpcPayload: LauncherPerformanceSettings & Record<string, unknown> = {
        inGameLauncherBehavior: 'zero_renderer_daemon',
        postGameLauncherBehavior: 'stay_minimized',
        pauseBackgroundSyncInGame: false,
        pauseDownloadsInGame: false,
        storefrontClientLifecycle: 'fast_direct_bypass',
        autoShutdownWinePrefixOnExit: false,
        suppressWineDebugLogging: false,
        defaultBottleDisplayScalingMode: 'force_fullscreen',
        defaultDisplayAspectRatio: 'integer',
        enableFullscreenHotkey: false,
        __proto_pollution_attempt__: 'blocked',
      };

      const ipcCleaned = securityAndPathUtils.sanitizeLauncherSettingsPayload(incomingIpcPayload);
      expect(ipcCleaned.__proto_pollution_attempt__).toBeUndefined();
      expect(ipcCleaned.defaultBottleDisplayScalingMode).toBe('force_fullscreen');
      expect(ipcCleaned.defaultDisplayAspectRatio).toBe('integer');
      expect(ipcCleaned.enableFullscreenHotkey).toBe(false);
      expect(ipcCleaned.storefrontClientLifecycle).toBe('fast_direct_bypass');
      expect(ipcCleaned.autoShutdownWinePrefixOnExit).toBe(false);
      expect(ipcCleaned.suppressWineDebugLogging).toBe(false);

      engineStateRegistry.saveLauncherPerformanceSettings(ipcCleaned, { userDataDir });
      const reloaded = engineStateRegistry.getLauncherPerformanceSettings({ userDataDir });
      const tsSanitized = sanitizePerformanceSettings(reloaded as Partial<LauncherPerformanceSettings>);

      expect(reloaded).toEqual({
        inGameLauncherBehavior: 'zero_renderer_daemon',
        postGameLauncherBehavior: 'stay_minimized',
        pauseBackgroundSyncInGame: false,
        pauseDownloadsInGame: false,
        storefrontClientLifecycle: 'fast_direct_bypass',
        autoShutdownWinePrefixOnExit: false,
        suppressWineDebugLogging: false,
        defaultBottleDisplayScalingMode: 'force_fullscreen',
        defaultDisplayAspectRatio: 'integer',
        enableFullscreenHotkey: false,
      });
      expect(tsSanitized).toEqual(reloaded);

      const resetCleaned = securityAndPathUtils.sanitizeLauncherSettingsPayload({ reset: true });
      expect(resetCleaned.reset).toBe(true);
      const afterReset = engineStateRegistry.saveLauncherPerformanceSettings(resetCleaned, {
        userDataDir,
      });
      expect(afterReset.defaultBottleDisplayScalingMode).toBe('auto_fullscreen');
      expect(afterReset.defaultDisplayAspectRatio).toBe('preserve_aspect');
      expect(afterReset.enableFullscreenHotkey).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 3. PE32/PE64 & Wrapper Capability Detection
  // --------------------------------------------------------------------------
  describe('3. PE32/PE64 & Wrapper Capability Detection (binaryAndManifestInspectors.cjs)', () => {
    it('distinguishes importsDdraw2d vs importsD3dImmediateMode, dynamic OpenGL via GDI pixel-format symbols, SDL1 vs SDL2+, and DOSBox', () => {
      const dir = makeTempDir('pe-caps');

      const ddrawExe = path.join(dir, 'SynthRetro2D.exe');
      fs.writeFileSync(
        ddrawExe,
        buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll', 'ddraw.dll'] })
      );
      const ddrawCaps = binaryInspectors.inspectPeCapabilities(ddrawExe, { strictPe: true });
      expect(ddrawCaps.importsDdraw2d).toBe(true);
      expect(ddrawCaps.importsD3dImmediateMode).toBe(false);
      expect(ddrawCaps.usesLegacyDdraw).toBe(true);

      const d3dimExe = path.join(dir, 'SynthRetro3D.exe');
      fs.writeFileSync(
        d3dimExe,
        buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll', 'd3dim700.dll'] })
      );
      const d3dimCaps = binaryInspectors.inspectPeCapabilities(d3dimExe, { strictPe: true });
      expect(d3dimCaps.importsDdraw2d).toBe(false);
      expect(d3dimCaps.importsD3dImmediateMode).toBe(true);
      expect(d3dimCaps.usesLegacyDdraw).toBe(true);

      // Dynamic QGL engine: imports GDI32.dll (NOT opengl32.dll) + ChoosePixelFormat/SetPixelFormat/SwapBuffers in .rdata
      const dynGlDir = path.join(dir, 'dyn-qgl');
      fs.mkdirSync(dynGlDir, { recursive: true });
      const dynGlExe = path.join(dynGlDir, 'SynthDynamicQgl32.exe');
      fs.writeFileSync(
        dynGlExe,
        buildSyntheticPeBuffer({
          arch: 'x86',
          importedDlls: ['KERNEL32.dll', 'USER32.dll', 'GDI32.dll'],
          rdataStrings: ['ChoosePixelFormat', 'SetPixelFormat', 'SwapBuffers'],
        })
      );
      const dynGlEffective = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        dynGlExe,
        dynGlDir,
        { strictPe: true }
      );
      expect(dynGlEffective.primaryPe.dynamicallyLoadsOpenGl).toBe(true);
      expect(dynGlEffective.usesOpenGl).toBe(true);
      expect(dynGlEffective.isLegacy32BitOpenGl).toBe(true);

      // SDL1 vs SDL2/SDL3
      const sdl1Exe = path.join(dir, 'SynthSdl1.exe');
      fs.writeFileSync(
        sdl1Exe,
        buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll', 'SDL.dll'] })
      );
      const sdl1Caps = binaryInspectors.inspectPeCapabilities(sdl1Exe, { strictPe: true });
      expect(sdl1Caps.importsSdl1).toBe(true);
      expect(sdl1Caps.importsModernSdl).toBe(false);

      const sdl2Exe = path.join(dir, 'SynthSdl2_64.exe');
      fs.writeFileSync(
        sdl2Exe,
        buildSyntheticPeBuffer({ arch: 'x64', importedDlls: ['KERNEL32.dll', 'SDL2.dll'] })
      );
      const sdl2Caps = binaryInspectors.inspectPeCapabilities(sdl2Exe, { strictPe: true });
      expect(sdl2Caps.importsSdl1).toBe(false);
      expect(sdl2Caps.importsModernSdl).toBe(true);

      // DOSBox executable detection
      const dosboxExe = path.join(dir, 'DOSBox.exe');
      fs.writeFileSync(
        dosboxExe,
        buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll', 'SDL.dll'] })
      );
      const dosboxCaps = binaryInspectors.inspectPeCapabilities(dosboxExe, { strictPe: true });
      expect(dosboxCaps.isDosboxExecutable).toBe(true);
    });

    it('traverses launcher_settings.cfg BinaryPath and goggame-*.info playTasks to resolve child PE32 & DOSBox capabilities', () => {
      // 3a. launcher_settings.cfg -> child PE32 OpenGL binary
      const wrapperDir = makeTempDir('wrapper-cfg');
      const launcherExe = path.join(wrapperDir, 'Launcher.exe');
      const subDir = path.join(wrapperDir, 'bin');
      fs.mkdirSync(subDir, { recursive: true });
      const childGlExe = path.join(subDir, 'SynthChildGl32.exe');

      fs.writeFileSync(
        launcherExe,
        buildSyntheticPeBuffer({ arch: 'x64', importedDlls: ['KERNEL32.dll', 'SHELL32.dll'] })
      );
      fs.writeFileSync(
        childGlExe,
        buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll', 'OPENGL32.dll'] })
      );
      fs.writeFileSync(
        path.join(wrapperDir, 'launcher_settings.cfg'),
        JSON.stringify({ BinaryPath: 'bin\\SynthChildGl32.exe' }),
        'utf8'
      );

      const cfgResolved = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        launcherExe,
        wrapperDir,
        { strictPe: true }
      );
      expect(cfgResolved.is32Bit).toBe(true);
      expect(cfgResolved.usesOpenGl).toBe(true);
      expect(cfgResolved.targetExeBasenamesLower).toEqual(
        expect.arrayContaining(['launcher.exe', 'synthchildgl32.exe'])
      );

      // 3b. goggame-*.info playTasks -> DOSBox child binary
      const gogDosDir = makeTempDir('gog-dosbox');
      const stubExe = path.join(gogDosDir, 'LaunchStub.exe');
      const dosSubDir = path.join(gogDosDir, 'DOSBOX');
      fs.mkdirSync(dosSubDir, { recursive: true });
      const nestedDosboxExe = path.join(dosSubDir, 'DOSBox.exe');

      fs.writeFileSync(
        stubExe,
        buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll'] })
      );
      fs.writeFileSync(
        nestedDosboxExe,
        buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll', 'SDL.dll'] })
      );
      fs.writeFileSync(
        path.join(gogDosDir, 'goggame-1000000042.info'),
        JSON.stringify({
          gameId: '1000000042',
          playTasks: [
            {
              isPrimary: true,
              category: 'game',
              path: 'DOSBOX\\DOSBox.exe',
              arguments: '-conf "..\\dosbox_synth.conf" -noconsole -c "exit"',
            },
          ],
        }),
        'utf8'
      );

      const gogResolved = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        stubExe,
        gogDosDir,
        { strictPe: true }
      );
      expect(gogResolved.isDosboxExecutable).toBe(true);
      expect(gogResolved.importsSdl1).toBe(true);
      expect(gogResolved.targetExeBasenamesLower).toContain('dosbox.exe');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Bottle Registry Self-Healing, id Tech r_mode Preservation & DOSBox Normalization
  // --------------------------------------------------------------------------
  describe('4. Bottle Registry Self-Healing, id Tech r_mode Preservation & DOSBox Normalization', () => {
    it('heals cxbottle.conf winxp -> win10, deletes stale global Explorer\\Desktop, heals global RetinaMode="y", and scopes legacy Mac Driver & Direct3D keys per-exe', () => {
      const bottleDir = makeTempDir('bottle-heal');
      createSyntheticBottleTree(bottleDir, {
        winVer: 'winxp',
        userRegExtra: [
          '[Software\\\\Wine\\\\Explorer]',
          '"Desktop"="OneLauncher"',
          '',
          '[Software\\\\Wine\\\\Mac Driver]',
          '"RetinaMode"="n"',
          '"OneLauncherManagedRetina"="1"',
          '"OneLauncherPriorRetina"="y"',
          '',
        ].join('\n'),
      });
      // Replace duplicate Mac Driver section with the poisoned one for clean test input
      const initialReg = [
        'WINE REGISTRY Version 2',
        '[Software\\\\Wine]',
        '"Version"="winxp"',
        '',
        '[Software\\\\Wine\\\\Explorer]',
        '"Desktop"="OneLauncher"',
        '',
        '[Software\\\\Wine\\\\Mac Driver]',
        '"RetinaMode"="n"',
        '"OneLauncherManagedRetina"="1"',
        '"OneLauncherPriorRetina"="y"',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(bottleDir, 'user.reg'), initialReg, 'utf8');

      const mockLayer = { id: 'crossover', type: 'crossover', name: 'CrossOver' };

      // 4a. Legacy 32-bit DirectDraw game in default auto_fullscreen mode:
      macNativeInstaller.applyCrossOverPerGameSettings(
        mockLayer,
        { crossoverGraphicsBackend: 'auto', displayScalingMode: 'auto_fullscreen' },
        {},
        bottleDir,
        {
          skipRegistrySpawn: true,
          skipLiveWineRegSync: true,
          maxWidth: 3024,
          maxHeight: 1964,
          logicalWidth: 1512,
          logicalHeight: 982,
          enableLegacyDisplayModeSynthesis: true,
          usesLegacyDirectDraw: true,
          targetExeNames: ['synthretroddraw.exe'],
          peCapabilities: {
            is32Bit: true,
            is64Bit: false,
            effectiveMachine: 'x86',
            importsDdraw2d: true,
            usesLegacyDdraw: true,
            importsLegacyD3dOrGl: true,
          },
        }
      );

      // cxbottle.conf has WineArch="win64", so WindowsVersion="winxp" self-heals to "win10"
      const healedConf = fs.readFileSync(path.join(bottleDir, 'cxbottle.conf'), 'utf8');
      expect(healedConf).toContain('"WindowsVersion" = "win10"');

      const regAfterLegacy = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      // Stale global Explorer\Desktop is deleted
      const globalExplorerSec =
        /\[Software\\\\Wine\\\\Explorer\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(regAfterLegacy);
      expect(globalExplorerSec?.[1] || '').not.toContain('"Desktop"');

      // Global Mac Driver RetinaMode healed to "y" and managed markers purged
      expect(regAfterLegacy).toMatch(/\[Software\\\\Wine\\\\Mac Driver\][^\[]*"RetinaMode"="y"/m);
      expect(regAfterLegacy).not.toContain('OneLauncherManagedRetina');
      expect(regAfterLegacy).not.toContain('OneLauncherPriorRetina');

      // Scoped per-exe Mac Driver & Direct3D keys
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\synthretroddraw\.exe\\\\Mac Driver\][^\[]*"RetinaMode"="y"/m
      );
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\synthretroddraw\.exe\\\\Mac Driver\][^\[]*"CaptureDisplaysForFullscreen"="n"/m
      );
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\synthretroddraw\.exe\\\\Mac Driver\][^\[]*"UseConfinementCursorClipping"="y"/m
      );
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\synthretroddraw\.exe\\\\Direct3D\][^\[]*"DirectDrawRenderer"="opengl"/m
      );
      expect(regAfterLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\synthretroddraw\.exe\\\\Direct3D\][^\[]*"renderer"="gl"/m
      );

      // 4b. Subsequent 64-bit launch heals global [Software\\Wine] Version="winxp" -> "win10"
      macNativeInstaller.applyCrossOverPerGameSettings(
        mockLayer,
        { crossoverGraphicsBackend: 'd3dmetal' },
        {},
        bottleDir,
        {
          skipRegistrySpawn: true,
          skipLiveWineRegSync: true,
          targetExeNames: ['synthmodern64.exe'],
          peCapabilities: {
            is32Bit: false,
            is64Bit: true,
            effectiveMachine: 'x64',
            importsD3d12: true,
          },
        }
      );
      const regAfter64 = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(regAfter64).toMatch(/\[Software\\\\Wine\][^\[]*"Version"="win10"/m);
    });

    it('preserves id Tech seta r_mode "17" & "-1" in auto_fullscreen and normalizes dosbox*.conf (surface -> opengl, openglnb preserved, desktop, aspect)', () => {
      const bottleDir = makeTempDir('bottle-cfg-dosbox');
      const installDir = makeTempDir('install-cfg-dosbox');
      createSyntheticBottleTree(bottleDir);

      // id Tech config with r_mode "17" and custom desktop mode "-1"
      const baseQ3Dir = path.join(installDir, 'baseq3');
      fs.mkdirSync(baseQ3Dir, { recursive: true });
      const q3CfgA = path.join(baseQ3Dir, 'q3config.cfg');
      const q3CfgB = path.join(baseQ3Dir, 'autoexec.cfg');
      fs.writeFileSync(q3CfgA, 'seta r_fullscreen "1"\nseta r_mode "17"\n', 'utf8');
      fs.writeFileSync(q3CfgB, 'seta r_fullscreen "1"\nseta r_mode "-1"\n', 'utf8');

      // DOSBox configs: one with surface + hardcoded 640x480, one with openglnb
      const dosConfSurface = path.join(installDir, 'dosbox_single.conf');
      const dosConfOpenGlNb = path.join(installDir, 'dosbox_sharp.conf');
      fs.writeFileSync(
        dosConfSurface,
        [
          '# Header comment preserved',
          '[sdl]',
          'fullscreen=false',
          'fullresolution=640x480',
          'output=surface',
          '',
          '[render]',
          'frameskip=0',
          'aspect=false',
          '',
          '[autoexec]',
          'mount c "."',
          'c:',
          'synthdos.exe',
        ].join('\r\n'),
        'utf8'
      );
      fs.writeFileSync(
        dosConfOpenGlNb,
        [
          '[sdl]',
          'fullscreen=false',
          'fullresolution=original',
          'output=openglnb',
          '[render]',
          'scaler=normal2x',
        ].join('\n'),
        'utf8'
      );

      const res = macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottleDir, {
        installDir,
        displayScalingMode: 'auto_fullscreen',
        displayAspectRatio: 'preserve_aspect',
        maxWidth: 1512,
        maxHeight: 982,
        logicalWidth: 1512,
        logicalHeight: 982,
        skipDisplayProbe: true,
      });

      // Neither id Tech config was clamped down
      expect(res.sanitizedFiles).toEqual([]);
      expect(fs.readFileSync(q3CfgA, 'utf8')).toContain('seta r_mode "17"');
      expect(fs.readFileSync(q3CfgB, 'utf8')).toContain('seta r_mode "-1"');

      // DOSBox surface config normalized to fullscreen=true, fullresolution=desktop, output=opengl, aspect=true, CRLF + [autoexec] intact
      const afterSurface = fs.readFileSync(dosConfSurface, 'utf8');
      expect(afterSurface).toContain('\r\n');
      expect(afterSurface).toContain('fullscreen=true');
      expect(afterSurface).toContain('fullresolution=desktop');
      expect(afterSurface).toContain('output=opengl');
      expect(afterSurface).toContain('aspect=true');
      expect(afterSurface).toContain('synthdos.exe');

      // DOSBox openglnb config preserves output=openglnb while setting fullscreen=true, fullresolution=desktop, and inserting aspect=true
      const afterNb = fs.readFileSync(dosConfOpenGlNb, 'utf8');
      expect(afterNb).toContain('fullscreen=true');
      expect(afterNb).toContain('fullresolution=desktop');
      expect(afterNb).toContain('output=openglnb');
      expect(afterNb).toContain('aspect=true');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Supervisor Wrapping, Live Toggle, Bidirectional Hotkey Sync & Native win32 Isolation
  // --------------------------------------------------------------------------
  describe('5. Supervisor Wrapping, Live Toggle, Bidirectional Hotkey Sync & Native win32 Isolation', () => {
    it('evaluates shouldWrapBottleSessionWithDisplayLauncher accurately across auto_fullscreen, force_fullscreen, windowed, and virtual_desktop', () => {
      const legacy32Gl = {
        is32Bit: true,
        is64Bit: false,
        usesOpenGl: true,
        usesLegacyDirectDrawOrD3d: false,
      };
      const modern64Dx12 = {
        is32Bit: false,
        is64Bit: true,
        importsD3d12: true,
        usesOpenGl: false,
        usesLegacyDirectDrawOrD3d: false,
        importsSdl1: false,
        isLauncherStubCandidate: false,
      };
      const modern64Vulkan = {
        is32Bit: false,
        is64Bit: true,
        importsVulkan: true,
        usesOpenGl: false,
        usesLegacyDirectDrawOrD3d: false,
      };
      const stub64Launcher = {
        is32Bit: false,
        is64Bit: true,
        isLauncherStubCandidate: true,
      };

      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(legacy32Gl, 'auto_fullscreen')
      ).toBe(true);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(legacy32Gl, 'auto')
      ).toBe(true);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(stub64Launcher, 'auto_fullscreen')
      ).toBe(true);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(stub64Launcher, 'auto')
      ).toBe(true);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(modern64Dx12, 'auto_fullscreen')
      ).toBe(false);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(modern64Dx12, 'auto')
      ).toBe(false);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(modern64Vulkan, 'auto_fullscreen')
      ).toBe(false);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(modern64Vulkan, 'auto')
      ).toBe(false);

      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(modern64Dx12, 'force_fullscreen')
      ).toBe(true);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(legacy32Gl, 'windowed')
      ).toBe(false);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(legacy32Gl, 'virtual_desktop')
      ).toBe(false);
    });

    it('wraps bottled macOS sessions with one_display_launcher, increments seq on toggleSessionFullscreen, and syncs live display_status_<sessionId>.json updates', async () => {
      const rootDir = makeTempDir('sup-bottle-mac');
      const homedir = path.join(rootDir, 'home');
      const userDataDir = path.join(rootDir, 'userdata');
      const appsDir = path.join(rootDir, 'Applications');
      const cxBinDir = path.join(
        appsDir,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin'
      );
      const bottlesDir = path.join(
        homedir,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles'
      );
      const bottleDir = path.join(bottlesDir, 'SynthBottle');
      fs.mkdirSync(cxBinDir, { recursive: true });
      createSyntheticBottleTree(bottleDir);
      const wineBin = path.join(cxBinDir, 'wine');
      fs.writeFileSync(
        wineBin,
        '#!/usr/bin/perl\n# Synthetic CXOpts wrapper supporting --wait-children and --dll\nexit 0;\n',
        { mode: 0o755 }
      );

      const gameDir = path.join(rootDir, 'Games', 'SynthRetroGl');
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'SynthRetroGl32.exe');
      fs.writeFileSync(
        gameExe,
        buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll', 'OPENGL32.dll'] })
      );

      const spawnedCalls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
      const fakeChild = createFakeChildProcess(51234);

      const sessionEvents: Array<Record<string, any>> = [];
      const unsubscribe = engineStateRegistry.onSessionUpdated((ev) => {
        sessionEvents.push(ev);
      });

      try {
        const launchRes = await supervisor.launchGame(
          {
            gameId: 'gog-synth-gl32',
            title: 'Synth Retro GL 32',
            platformId: 'gog',
            installPath: gameDir,
            executablePath: gameExe,
            launchConfig: {
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
              wineBottleName: 'SynthBottle',
              winePrefixPath: bottleDir,
              displayScalingMode: 'auto_fullscreen',
              displayAspectRatio: 'preserve_aspect',
            },
          },
          {
            platform: 'darwin',
            arch: 'arm64',
            homedir,
            userDataDir,
            customApplicationsDir: appsDir,
            enableDisplayScalerInTests: true,
            enableDisplayStatusSyncInTests: true,
            displayStatusPollMs: 80,
            safeInsetTop: 37,
            skipRegistrySpawn: true,
            gameSpawnFn: (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
              spawnedCalls.push({ cmd, args: [...args], env: { ...(opts?.env || {}) } });
              return fakeChild;
            },
          }
        );

        expect(launchRes.success).toBe(true);
        const session = launchRes.session;
        expect(session.isBottledSession).toBe(true);
        expect(session.fullscreenActive).toBe(true);
        expect(session.displayAspectRatio).toBe('preserve_aspect');

        expect(spawnedCalls.length).toBeGreaterThanOrEqual(1);
        const primarySpawn = spawnedCalls[0];
        expect(
          primarySpawn.args.some((a) => a.endsWith('one_display_launcher_x86.exe'))
        ).toBe(true);
        expect(primarySpawn.args).toContain('--dll-x86');
        expect(primarySpawn.args).toContain('--dll-x64');
        expect(primarySpawn.env.ONE_LAUNCHER_DISPLAY_SCALING_MODE).toBe('auto_fullscreen');
        expect(primarySpawn.env.ONE_LAUNCHER_DISPLAY_ASPECT).toBe('preserve_aspect');
        expect(primarySpawn.env.ONE_LAUNCHER_SAFE_INSET_TOP).toBe('0');

        const stageDir = path.join(
          bottleDir,
          'drive_c',
          'ProgramData',
          'OneLauncher',
          'display_scaler'
        );
        const ctlPath = path.join(stageDir, `display_ctl_${session.sessionId}.ini`);
        const statusPath = path.join(stageDir, `display_status_${session.sessionId}.json`);
        expect(fs.existsSync(ctlPath)).toBe(true);
        expect(fs.readFileSync(ctlPath, 'utf8')).toBe(
          'seq=1\nfullscreen=1\naspect=preserve_aspect\nsafe_inset_top=0\n'
        );

        // Toggle fullscreen via IPC/supervisor -> seq=2, fullscreen=0, aspect=integer
        const toggleRes = supervisor.toggleSessionFullscreen({
          gameId: 'gog-synth-gl32',
          aspectRatio: 'integer',
        });
        expect(toggleRes.success).toBe(true);
        expect(toggleRes.fullscreenActive).toBe(false);
        expect(toggleRes.displayAspectRatio).toBe('integer');
        expect(fs.readFileSync(ctlPath, 'utf8')).toBe('seq=2\nfullscreen=0\naspect=integer\nsafe_inset_top=0\n');
        expect(
          sessionEvents.some(
            (e) =>
              e.event === 'fullscreen_updated' &&
              e.session?.sessionId === session.sessionId &&
              e.session?.fullscreenActive === false
          )
        ).toBe(true);

        // Simulate in-game hotkey writing display_status_<sessionId>.json -> supervisor polls & emits fullscreen_updated
        sessionEvents.length = 0;
        const futureTime = new Date(Date.now() + 5000);
        fs.writeFileSync(
          statusPath,
          JSON.stringify({
            seq: 3,
            fullscreen: true,
            aspect: 'stretch',
            pid: 51234,
          }),
          'utf8'
        );
        fs.utimesSync(statusPath, futureTime, futureTime);

        await vi.waitFor(
          () => {
            expect(
              sessionEvents.some(
                (e) =>
                  e.event === 'fullscreen_updated' &&
                  e.session?.fullscreenActive === true &&
                  e.session?.displayAspectRatio === 'stretch'
              )
            ).toBe(true);
          },
          { timeout: 3000, interval: 40 }
        );

        await supervisor.finalizeGameSession('gog-synth-gl32', { userDataDir });
      } finally {
        unsubscribe();
      }
    });

    it('strictly isolates native Windows (win32) launches with zero display_scaler staging, wrapping, or env vars', async () => {
      const rootDir = makeTempDir('sup-native-win32');
      const homedir = path.join(rootDir, 'home');
      const userDataDir = path.join(rootDir, 'userdata');
      const gameDir = path.join(rootDir, 'Games', 'SynthNativeWin');
      fs.mkdirSync(gameDir, { recursive: true });
      const winExe = path.join(gameDir, 'SynthNativeWin64.exe');
      fs.writeFileSync(
        winExe,
        buildSyntheticPeBuffer({ arch: 'x64', importedDlls: ['KERNEL32.dll', 'd3d11.dll'] })
      );

      const spawnedCalls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
      const fakeWinChild = createFakeChildProcess(60900);

      const launchRes = await supervisor.launchGame(
        {
          gameId: 'gog-synth-win64',
          title: 'Synth Native Win 64',
          platformId: 'gog',
          installPath: gameDir,
          executablePath: winExe,
          launchConfig: {
            launchMethod: 'direct',
            customExecutablePath: winExe,
            displayScalingMode: 'force_fullscreen',
          },
        },
        {
          platform: 'win32',
          homedir,
          userDataDir,
          startupWaitMs: 0,
          enableDisplayScalerInTests: true,
          gameSpawnFn: (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
            spawnedCalls.push({ cmd, args: [...args], env: { ...(opts?.env || {}) } });
            return fakeWinChild;
          },
        }
      );

      expect(launchRes.success).toBe(true);
      expect(Boolean(launchRes.session.isBottledSession)).toBe(false);
      expect(spawnedCalls.length).toBe(1);
      expect(spawnedCalls[0].cmd).toBe(winExe);
      expect(
        spawnedCalls[0].args.some((a) => /one_display_launcher/i.test(a))
      ).toBe(false);
      expect(spawnedCalls[0].env.ONE_LAUNCHER_DISPLAY_SCALING_MODE).toBeUndefined();
      expect(spawnedCalls[0].env.ONE_LAUNCHER_DISPLAY_CONTROL_FILE).toBeUndefined();

      const rejectToggle = supervisor.toggleSessionFullscreen('gog-synth-win64');
      expect(rejectToggle.success).toBe(false);

      await supervisor.finalizeGameSession('gog-synth-win64', { userDataDir });
    });
  });

  // --------------------------------------------------------------------------
  // 6. React UI Controls & WCAG 2.2 AA Accessibility
  // --------------------------------------------------------------------------
  describe('6. React UI Controls & WCAG 2.2 AA Accessibility (CompatibilityLayerSection, StorefrontLifecycleSection, SteamLibraryActionBar)', () => {
    const basePreview: ResolvedLaunchModePreview = {
      hostPlatform: 'darwin',
      platformId: 'gog',
      isInstalled: true,
      detectedBuildType: 'windows_exe_on_mac',
      detectedBuildLabel: 'Windows Build (CrossOver Bottle)',
      detectedBuildDetail: 'Runs Windows executable via CrossOver bottle.',
      autoResolvedMethod: 'compatibility_layer',
      autoResolvedSummary: 'CrossOver Bottle (SynthBottle)',
      defaultLaunchMethod: 'auto',
      recommendedModes: ['auto', 'compatibility_layer'],
      availableModes: ['auto', 'compatibility_layer', 'direct'],
      executableArchitecture: 'x86',
      is32BitExecutable: true,
      visibleSections: {
        compatibilityLayer: true,
        crossoverRendering: true,
        nativeMacMetalHud: false,
        executableAndArgs: true,
        environmentAndHooks: true,
      },
      modeNotes: {
        auto: { dynamicDesc: 'Automatic bottle launch.' },
        direct: { dynamicDesc: 'Direct executable launch.' },
        storefront_uri: { dynamicDesc: 'Storefront client URI.' },
        compatibility_layer: { dynamicDesc: 'CrossOver bottle launch.' },
        custom: { dynamicDesc: 'Legacy custom mode.' },
      },
    };

    const mockLayer: CompatibilityLayerInfo = {
      id: 'crossover',
      name: 'CrossOver',
      type: 'crossover',
      binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
      appPath: '/Applications/CrossOver.app',
      available: true,
      version: '25.0.0',
      availableBottles: ['SynthBottle'],
      darwinKernelMajor: 25,
      supportsMetalFxDlssD3dMetal: true,
      supportsMetalFxDlssDxmt: true,
    };

    it('renders CompatibilityLayerSection display scaling controls, toggles conditional aspect/resolution selects, hides on Windows, and passes WCAG 2.2 AA', () => {
      let currentScaling: BottleDisplayScalingMode = 'default';
      let currentAspect: DisplayAspectRatioMode = 'default';
      let currentVdRes = 'auto';

      const buildProps = (isWindowsHost = false) => ({
        idPrefix: 'qa-compat',
        isWindowsHost,
        preview: basePreview,
        activeDisplayMethod: 'compatibility_layer' as const,
        detectedLayers: [mockLayer],
        runnerUpdates: {},
        compatibilityLayer: 'crossover' as const,
        onSelectCompatibilityLayer: () => {},
        availableBottles: ['SynthBottle'],
        wineBottleName: 'SynthBottle',
        onChangeWineBottleName: () => {},
        selectedRunnerDescriptor: {
          type: 'crossover' as const,
          label: 'CrossOver (Recommended)',
          shortLabel: 'CrossOver',
          vendor: 'CodeWeavers',
          description: 'Commercial Wine compatibility runner with D3DMetal & DXMT.',
          bestFor: 'DirectX 9–12, DirectDraw, and OpenGL Windows titles on macOS.',
          downloadUrl: 'https://www.codeweavers.com/crossover',
          downloadLabel: 'Download CrossOver',
        },
        activeLayer: mockLayer,
        activeInstalledVer: '25.0.0',
        activeSecondaryBuildText: 'CrossOver 25',
        isCheckingUpdates: false,
        isUpdatingRunner: false,
        onUpdateRunner: () => {},
        onCheckRunnerUpdates: () => {},
        onOpenBottleFolder: () => {},
        isRescanningRunners: false,
        onRescanLayers: () => {},
        isInstallingRunner: false,
        onInstallRunnerViaBrew: () => {},
        onDownloadRunner: () => {},
        runnerUpdateFeedback: null,
        runnerActionFeedback: null,
        winePrefixPath: '',
        onChangeWinePrefixPath: () => {},
        onBrowseWinePrefix: () => {},
        crossoverGraphicsBackend: 'auto' as const,
        onChangeCrossoverGraphicsBackend: () => {},
        crossoverD3DMetalVersion: 'auto' as const,
        onChangeCrossoverD3DMetalVersion: () => {},
        showD3DMetalVersionSelector: false,
        primaryD3DVer: '2.1',
        fallbackD3DVer: '2.0',
        crossoverHighResolutionMode: undefined,
        onChangeCrossoverHighResolutionMode: () => {},
        isDlssSupportedBackend: false,
        isDxvkHudSupported: true,
        crossoverDlss: false,
        onToggleCrossoverDlss: () => {},
        displayScalingMode: currentScaling,
        onChangeDisplayScalingMode: (val: BottleDisplayScalingMode) => {
          currentScaling = val;
        },
        displayAspectRatio: currentAspect,
        onChangeDisplayAspectRatio: (val: DisplayAspectRatioMode) => {
          currentAspect = val;
        },
        virtualDesktopResolution: currentVdRes,
        onChangeVirtualDesktopResolution: (val: string) => {
          currentVdRes = String(val);
        },
        defaultBottleDisplayScalingMode: 'auto_fullscreen' as const,
        defaultDisplayAspectRatio: 'preserve_aspect' as const,
        enableFullscreenHotkey: true,
        wineMsync: true,
        onToggleWineMsync: () => {},
        wineEsync: false,
        onToggleWineEsync: () => {},
        metalHud: false,
        onToggleMetalHud: () => {},
        dxvkHud: false,
        onToggleDxvkHud: () => {},
      });

      const renderer = createDomain12DeepRenderer(CompatibilityLayerSection, buildProps(false));

      // Default (`auto_fullscreen` inherited): shows aspect select, hides virtual desktop resolution select
      const treeAuto = renderer.render(buildProps(false));
      expect(
        findVNodes(treeAuto, (n) => n.props?.['data-testid'] === 'display-fullscreen-scaling-panel')
          .length
      ).toBe(1);
      const scalingSelect = findVNodes(
        treeAuto,
        (n) => n.props?.['data-testid'] === 'display-scaling-mode-select'
      )[0];
      const aspectSelect = findVNodes(
        treeAuto,
        (n) => n.props?.['data-testid'] === 'display-aspect-ratio-select'
      )[0];
      expect(scalingSelect).toBeDefined();
      expect(aspectSelect).toBeDefined();
      expect(
        findVNodes(treeAuto, (n) => n.props?.['data-testid'] === 'virtual-desktop-resolution-select')
          .length
      ).toBe(0);
      expect(auditWcag22AA(treeAuto)).toEqual([]);

      // Change scaling mode to `virtual_desktop` and aspect to `integer`
      aspectSelect.props.onChange({ target: { value: 'integer' } });
      expect(currentAspect).toBe('integer');
      scalingSelect.props.onChange({ target: { value: 'virtual_desktop' } });
      expect(currentScaling).toBe('virtual_desktop');

      const treeVd = renderer.render(buildProps(false));
      expect(
        findVNodes(treeVd, (n) => n.props?.['data-testid'] === 'display-aspect-ratio-select').length
      ).toBe(0);
      const vdResSelect = findVNodes(
        treeVd,
        (n) => n.props?.['data-testid'] === 'virtual-desktop-resolution-select'
      )[0];
      expect(vdResSelect).toBeDefined();
      vdResSelect.props.onChange({ target: { value: '1280x960' } });
      expect(currentVdRes).toBe('1280x960');
      expect(auditWcag22AA(treeVd)).toEqual([]);

      // Hidden on Windows host
      const treeWin = renderer.render(buildProps(true));
      expect(treeWin).toBeNull();
    });

    it('renders StorefrontLifecycleSection global bottle display defaults & hotkey switch and passes WCAG 2.2 AA', () => {
      let globalMode: GlobalBottleDisplayScalingMode = 'auto_fullscreen';
      let globalAspect: GlobalDisplayAspectRatioMode = 'preserve_aspect';
      let hotkeyEnabled = true;

      const buildProps = (isWindowsHost: boolean) => {
        const perf: LauncherPerformanceSettings = {
          ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
          defaultBottleDisplayScalingMode: globalMode,
          defaultDisplayAspectRatio: globalAspect,
          enableFullscreenHotkey: hotkeyEnabled,
        };
        return {
          idPrefix: 'qa-lifecycle',
          isWindowsHost,
          preview: basePreview,
          activeDisplayMethod: 'compatibility_layer' as const,
          preferredPlatformId: 'gog' as const,
          inGameLauncherBehavior: 'default' as const,
          onChangeInGameLauncherBehavior: () => {},
          storefrontClientLifecycle: 'default' as const,
          onChangeStorefrontClientLifecycle: () => {},
          perfSettings: perf,
          onChangePostGameBehavior: () => {},
          onTogglePauseSyncInGame: () => {},
          onTogglePauseDownloadsInGame: () => {},
          onToggleAutoShutdownWine: () => {},
          onChangeDefaultBottleDisplayScalingMode: (v: GlobalBottleDisplayScalingMode) => {
            globalMode = v;
          },
          onChangeDefaultDisplayAspectRatio: (v: GlobalDisplayAspectRatioMode) => {
            globalAspect = v;
          },
          onToggleFullscreenHotkey: () => {
            hotkeyEnabled = !hotkeyEnabled;
          },
        };
      };

      const renderer = createDomain12DeepRenderer(StorefrontLifecycleSection, buildProps(false));
      const treeMac = renderer.render(buildProps(false));
      const modeSel = findVNodes(
        treeMac,
        (n) => n.props?.['data-testid'] === 'global-bottle-display-mode-select'
      )[0];
      const aspectSel = findVNodes(
        treeMac,
        (n) => n.props?.['data-testid'] === 'global-display-aspect-select'
      )[0];
      const hotkeySwitch = findVNodes(
        treeMac,
        (n) => n.props?.['data-testid'] === 'toggle-fullscreen-hotkey'
      )[0];

      expect(modeSel).toBeDefined();
      expect(aspectSel).toBeDefined();
      expect(hotkeySwitch).toBeDefined();
      expect(hotkeySwitch.props.role).toBe('switch');
      expect(hotkeySwitch.props['aria-checked']).toBe(true);
      expect(auditWcag22AA(treeMac)).toEqual([]);

      modeSel.props.onChange({ target: { value: 'force_fullscreen' } });
      aspectSel.props.onChange({ target: { value: 'integer' } });
      hotkeySwitch.props.onClick();

      expect(globalMode).toBe('force_fullscreen');
      expect(globalAspect).toBe('integer');
      expect(hotkeyEnabled).toBe(false);

      const treeMacUpdated = renderer.render(buildProps(false));
      const updatedSwitch = findVNodes(
        treeMacUpdated,
        (n) => n.props?.['data-testid'] === 'toggle-fullscreen-hotkey'
      )[0];
      expect(updatedSwitch.props['aria-checked']).toBe(false);
      expect(auditWcag22AA(treeMacUpdated)).toEqual([]);

      // Windows host omits macOS bottle display defaults while remaining 100% WCAG compliant
      const treeWin = renderer.render(buildProps(true));
      expect(
        findVNodes(
          treeWin,
          (n) => n.props?.['data-testid'] === 'global-bottle-display-mode-select'
        ).length
      ).toBe(0);
      expect(auditWcag22AA(treeWin)).toEqual([]);
    });

    it('renders SteamLibraryActionBar live-session-fullscreen-toggle during bottled macOS sessions, flips aria-pressed & label, and passes WCAG 2.2 AA', async () => {
      const synthGame: CanonicalGame = {
        id: 'gog-synth-actionbar',
        title: 'Synth Bottled Adventure',
        sortTitle: 'synth bottled adventure',
        headerImage: '',
        developers: ['Synth Studio'],
        publishers: ['Synth Publishing'],
        genres: ['Adventure'],
        tags: ['Singleplayer'],
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1000000999',
            installed: true,
            installSize: 512 * 1024 * 1024,
          },
        ],
      };

      let sessionFullscreen = false;
      const makeSession = (): ActiveGameSession => ({
        sessionId: 'sess-synth-ab-1',
        gameId: synthGame.id,
        title: synthGame.title,
        platformId: 'gog',
        platformGameId: '1000000999',
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        status: 'running',
        launchMethod: 'compatibility_layer',
        isBottledSession: true,
        fullscreenActive: sessionFullscreen,
        displayAspectRatio: 'preserve_aspect',
      });

      vi.spyOn(launcherService, 'getRunningGames').mockImplementation(() => [makeSession()]);
      vi.spyOn(launcherService, 'isGameRunning').mockReturnValue(true);
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      const toggleSpy = vi
        .spyOn(launcherService, 'toggleSessionFullscreen')
        .mockImplementation(async () => {
          sessionFullscreen = !sessionFullscreen;
          return {
            success: true,
            sessionId: 'sess-synth-ab-1',
            gameId: synthGame.id,
            fullscreenActive: sessionFullscreen,
            displayAspectRatio: 'preserve_aspect',
          };
        });

      const renderer = createDomain12DeepRenderer(SteamLibraryActionBar, {
        game: synthGame,
        collections: [],
      });
      const treeWindowed = renderer.render({ game: synthGame, collections: [] });
      const toggleBtnWindowed = findVNodes(
        treeWindowed,
        (n) => n.props?.['data-testid'] === 'live-session-fullscreen-toggle'
      )[0];
      expect(toggleBtnWindowed).toBeDefined();
      expect(toggleBtnWindowed.props['aria-pressed']).toBe(false);
      expect(extractVNodeText(toggleBtnWindowed)).toContain('Fullscreen');
      expect(auditWcag22AA(treeWindowed)).toEqual([]);

      await toggleBtnWindowed.props.onClick();
      expect(toggleSpy).toHaveBeenCalledWith(synthGame.id);

      const treeFullscreen = renderer.render({ game: synthGame, collections: [] });
      const toggleBtnFullscreen = findVNodes(
        treeFullscreen,
        (n) => n.props?.['data-testid'] === 'live-session-fullscreen-toggle'
      )[0];
      expect(toggleBtnFullscreen.props['aria-pressed']).toBe(true);
      expect(extractVNodeText(toggleBtnFullscreen)).toContain('Windowed');
      expect(auditWcag22AA(treeFullscreen)).toEqual([]);

      // Native Windows host hides bottled live-session-fullscreen-toggle
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(true);
      const treeWinHost = renderer.render({ game: synthGame, collections: [] });
      expect(
        findVNodes(
          treeWinHost,
          (n) => n.props?.['data-testid'] === 'live-session-fullscreen-toggle'
        ).length
      ).toBe(0);
    });
  });

  describe('10. Live 3D Mode-Switch, WineD3D GL Blit & Cold-Bottle Job Exit Hardening', () => {
    it('verifies compiled scaler & launcher binaries embed ShowWindow, glBlitFramebuffer, and Wine daemon job guards within < 120 KB budget', () => {
      const verified = buildDisplayScaler.verifyDisplayScalerBinaries();
      expect(verified.scalerX86.sizeBytes).toBeLessThan(buildDisplayScaler.MAX_BINARY_SIZE_BYTES);
      expect(verified.scalerX64.sizeBytes).toBeLessThan(buildDisplayScaler.MAX_BINARY_SIZE_BYTES);
      expect(verified.launcherX86.sizeBytes).toBeLessThan(buildDisplayScaler.MAX_BINARY_SIZE_BYTES);
      expect(verified.launcherX64.sizeBytes).toBeLessThan(buildDisplayScaler.MAX_BINARY_SIZE_BYTES);

      for (const binPath of [verified.scalerX86.path, verified.scalerX64.path]) {
        const rawAscii = fs.readFileSync(binPath).toString('latin1');
        expect(rawAscii).toContain('ShowWindow');
        expect(rawAscii).toContain('ShowWindowAsync');
        expect(rawAscii).toContain('SetWindowPlacement');
        expect(rawAscii).toContain('glBlitFramebuffer');
        expect(rawAscii).toContain('glBlitFramebufferEXT');
      }

      const repoRoot = path.resolve(__dirname, '..');
      const windowSrc = fs.readFileSync(
        path.join(repoRoot, 'electron/helpers/display_scaler/display_scaler_window.c'),
        'utf8'
      );
      expect(windowSrc).toContain('WS_MAXIMIZE');
      expect(windowSrc).toContain('GCLP_HBRBACKGROUND');
      expect(windowSrc).toContain('WM_GETMINMAXINFO');
      expect(windowSrc).toContain('WM_STYLECHANGING');
      expect(windowSrc).toContain('ds_ensure_game_window_bounds');

      const glSrc = fs.readFileSync(
        path.join(repoRoot, 'electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
        'utf8'
      );
      expect(glSrc).toContain('hook_glBlitFramebuffer');
      expect(glSrc).toContain('ds_ensure_game_window_bounds(win)');

      const launcherSrc = fs.readFileSync(
        path.join(repoRoot, 'electron/helpers/display_scaler/display_launcher.c'),
        'utf8'
      );
      expect(launcherSrc).toContain('is_excluded_pid(pid)');
      expect(launcherSrc).toContain('jeli_clear.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK');
    });
  });

  describe('11. Display Scaler v3: Modern Dynamic-Import Bypass, AppCompat HIGHDPIAWARE, Shared-Bottle Healing, Multi-Display & Portability', () => {
    interface ExtendedPeSpec extends SyntheticPeSpec {
      rdataSize?: number;
      rdataTailStrings?: string[];
      rsrcManifestXml?: string;
    }

    function buildExtendedSyntheticPeBuffer(spec: ExtendedPeSpec): Buffer {
      const rdataSize = Math.max(0x1000, Math.ceil((spec.rdataSize || 0x1000) / 0x200) * 0x200);
      const rsrcBuf = spec.rsrcManifestXml ? Buffer.from(spec.rsrcManifestXml, 'utf8') : null;
      const rsrcSize = rsrcBuf ? Math.max(0x400, Math.ceil((rsrcBuf.length + 16) / 0x200) * 0x200) : 0;
      const numSections = rsrcBuf ? 2 : 1;
      const totalSize = 0x200 + rdataSize + rsrcSize;
      const buf = Buffer.alloc(totalSize, 0);
      const peOffset = 0x80;

      buf.writeUInt16LE(0x5a4d, 0x00); // 'MZ'
      buf.writeUInt32LE(peOffset, 0x3c); // e_lfanew
      buf.writeUInt32LE(0x00004550, peOffset); // 'PE\0\0'
      const isX64 = spec.arch === 'x64';
      buf.writeUInt16LE(isX64 ? 0x8664 : 0x014c, peOffset + 4);
      buf.writeUInt16LE(numSections, peOffset + 6);

      const optHeaderSize = isX64 ? 0xf0 : 0xe0;
      buf.writeUInt16LE(optHeaderSize, peOffset + 20);
      let characteristics = 0x0002;
      if (spec.largeAddressAware) characteristics |= 0x0020;
      if (!isX64 && !spec.largeAddressAware) characteristics |= 0x0100;
      if (spec.isDll) characteristics |= 0x2000;
      buf.writeUInt16LE(characteristics, peOffset + 22);

      const optOffset = peOffset + 24;
      buf.writeUInt16LE(isX64 ? 0x020b : 0x010b, optOffset);
      if (isX64) {
        buf.writeBigUInt64LE(0x0000000140000000n, optOffset + 24);
      } else {
        buf.writeUInt32LE(0x00400000, optOffset + 28);
      }

      let dllChars = 0;
      if (spec.dynamicBase ?? true) dllChars |= 0x0040;
      if (spec.nxCompat ?? true) dllChars |= 0x0100;
      buf.writeUInt16LE(dllChars, optOffset + 70);

      const numRvaOffset = optOffset + (isX64 ? 108 : 92);
      buf.writeUInt32LE(16, numRvaOffset);
      const dataDirOffset = optOffset + (isX64 ? 112 : 96);

      const secTableOffset = optOffset + optHeaderSize;
      buf.write('.rdata\0\0', secTableOffset, 'ascii');
      buf.writeUInt32LE(rdataSize, secTableOffset + 8);
      buf.writeUInt32LE(0x1000, secTableOffset + 12);
      buf.writeUInt32LE(rdataSize, secTableOffset + 16);
      buf.writeUInt32LE(0x0200, secTableOffset + 20);
      buf.writeUInt32LE(0x40000040, secTableOffset + 36);

      if (rsrcBuf) {
        const sec1 = secTableOffset + 40;
        buf.write('.rsrc\0\0\0', sec1, 'ascii');
        buf.writeUInt32LE(rsrcSize, sec1 + 8);
        buf.writeUInt32LE(0x1000 + rdataSize, sec1 + 12);
        buf.writeUInt32LE(rsrcSize, sec1 + 16);
        buf.writeUInt32LE(0x0200 + rdataSize, sec1 + 20);
        buf.writeUInt32LE(0x40000040, sec1 + 36);
        rsrcBuf.copy(buf, 0x0200 + rdataSize);
      }

      const rvaToFile = (rva: number): number => 0x0200 + (rva - 0x1000);
      let stringCursorRva = 0x1400;
      const writeAsciiRva = (text: string): number => {
        const rva = stringCursorRva;
        const raw = rvaToFile(rva);
        buf.write(text, raw, 'ascii');
        buf[raw + text.length] = 0;
        stringCursorRva += text.length + 1;
        if (stringCursorRva % 2 !== 0) stringCursorRva += 1;
        return rva;
      };

      const importedDlls = spec.importedDlls || [];
      if (importedDlls.length > 0) {
        const importDirRva = 0x1000;
        const importDirSize = (importedDlls.length + 1) * 20;
        buf.writeUInt32LE(importDirRva, dataDirOffset + 1 * 8);
        buf.writeUInt32LE(importDirSize, dataDirOffset + 1 * 8 + 4);
        for (let i = 0; i < importedDlls.length; i += 1) {
          const nameRva = writeAsciiRva(importedDlls[i]);
          const descFileOff = rvaToFile(importDirRva + i * 20);
          buf.writeUInt32LE(nameRva, descFileOff + 12);
        }
      }

      for (const literal of spec.rdataStrings || []) {
        writeAsciiRva(literal);
      }

      if (spec.rdataTailStrings && spec.rdataTailStrings.length > 0) {
        let tailOff = 0x0200 + Math.max(0x90000, rdataSize - 0x2000);
        for (const literal of spec.rdataTailStrings) {
          buf.write(literal, tailOff, 'ascii');
          buf[tailOff + literal.length] = 0;
          tailOff += literal.length + 2;
        }
      }

      return buf;
    }

    it('detects dynamic DX11/DXGI in large CryEngine-style sibling DLL (>512 KiB offset), skips scaler in auto_fullscreen, and strips scaler env + writes active_session.ini mode=off', async () => {
      const root = makeTempDir('cryengine-v3');
      const binDir = path.join(root, 'Bin', 'Win64');
      fs.mkdirSync(binDir, { recursive: true });

      const exePath = path.join(binDir, 'MedievalRPG.exe');
      const engineDllPath = path.join(binDir, 'EngineGameCore.dll');
      fs.writeFileSync(
        exePath,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          largeAddressAware: true,
          importedDlls: ['kernel32.dll', 'user32.dll', 'EngineGameCore.dll'],
        })
      );
      // 1.5 MiB .rdata section with d3d11.dll\0 and dxgi.dll\0 past 512 KiB (at ~1.49 MiB)
      fs.writeFileSync(
        engineDllPath,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          isDll: true,
          largeAddressAware: true,
          importedDlls: ['kernel32.dll', 'user32.dll'],
          rdataSize: 0x180000,
          rdataTailStrings: ['d3d11.dll', 'dxgi.dll'],
        })
      );

      const caps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(exePath, root);
      expect(caps.is64Bit).toBe(true);
      expect(caps.usesModernGraphicsApi).toBe(true);
      expect(caps.isLauncherStubCandidate).toBe(false);
      expect(caps.usesLegacyDdraw).toBe(false);
      expect(caps.importsOpenGl).toBe(false);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(caps, 'auto_fullscreen')
      ).toBe(false);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(caps, 'force_fullscreen')
      ).toBe(true);

      // Launch unwrapped in auto_fullscreen: must NOT wrap, must strip stale scaler env, and must write mode=off to existing active_session.ini
      const homedir = path.join(root, 'home');
      const appsDir = path.join(root, 'Applications');
      const bottleDir = path.join(
        homedir,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'SynthBottle'
      );
      createSyntheticBottleTree(bottleDir);
      const fakeWineBin = path.join(
        appsDir,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin',
        'wine'
      );
      fs.mkdirSync(path.dirname(fakeWineBin), { recursive: true });
      fs.writeFileSync(fakeWineBin, '#!/usr/bin/perl\nexit 0;\n', { mode: 0o755 });

      // Pre-stage stale active_session.ini from an earlier legacy game on the same bottle
      const staged = supervisor.stageBottleDisplayScalerBinaries(bottleDir);
      expect(staged.allPresent).toBe(true);
      const activeSessionPath = path.join(staged.stageDirPosix, 'active_session.ini');
      fs.writeFileSync(activeSessionPath, 'seq=9\nmode=auto_fullscreen\nfullscreen=1\n', 'utf8');

      const spawnCalls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
      const fakeChild = createFakeChildProcess(62101);
      const launchRes = await supervisor.launchGame(
        {
          gameId: 'gog-cryengine-v3',
          title: 'Medieval RPG Synth',
          platformId: 'gog',
          platformGameId: '1000000777',
          installPath: root,
          executablePath: exePath,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            wineBottleName: 'SynthBottle',
            winePrefixPath: bottleDir,
            displayScalingMode: 'auto_fullscreen',
            environmentVariables: {
              ONE_LAUNCHER_SCALER_DLL_X64: 'C:\\stale\\scaler.dll',
              ONE_LAUNCHER_DISPLAY_CONTROL_FILE: 'C:\\stale\\ctl.ini',
            },
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir: path.join(root, 'UserData'),
          customApplicationsDir: appsDir,
          enableDisplayScalerInTests: true,
          skipRegistrySpawn: true,
          gameSpawnFn: (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
            spawnCalls.push({ cmd, args: [...args], env: { ...(opts?.env || {}) } });
            return fakeChild;
          },
        }
      );

      expect(launchRes.success).toBe(true);
      expect(spawnCalls.length).toBe(1);
      // Must NOT invoke one_display_launcher_*.exe
      expect(spawnCalls[0].args.join(' ')).not.toContain('one_display_launcher');
      // Stale scaler env vars stripped cleanly
      expect(spawnCalls[0].env.ONE_LAUNCHER_SCALER_DLL_X64).toBeUndefined();
      expect(spawnCalls[0].env.ONE_LAUNCHER_SCALER_DLL_X86).toBeUndefined();
      expect(spawnCalls[0].env.ONE_LAUNCHER_DISPLAY_CONTROL_FILE).toBeUndefined();
      expect(spawnCalls[0].env.ONE_LAUNCHER_DISPLAY_STATUS_FILE).toBeUndefined();
      expect(spawnCalls[0].env.ONE_LAUNCHER_DISPLAY_SCALING_MODE).toBe('off');
      // Stale active_session.ini neutralized to mode=off with hotkey=0 and empty control/status files
      const activeIni = fs.readFileSync(activeSessionPath, 'utf8');
      expect(activeIni).toContain('mode=off');
      expect(activeIni).toContain('hotkey=0');
      expect(activeIni).toContain('control_file=\n');
      // DPI-unaware modern x64 game received lowercase AppCompatFlags\Layers HIGHDPIAWARE
      const userReg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(userReg).toContain(
        '[Software\\\\Microsoft\\\\Windows NT\\\\CurrentVersion\\\\AppCompatFlags\\\\Layers]'
      );
      expect(userReg).toContain('"medievalrpg.exe"="~ HIGHDPIAWARE"');

      await supervisor.finalizeGameSession('gog-cryengine-v3', {
        platform: 'darwin',
        userDataDir: path.join(root, 'UserData'),
      });
    });

    it('classifies libcef.dll & Qt5WebEngineCore.dll as redists so a 64-bit CEF launcher stub still wraps and propagates to a 32-bit legacy child game', () => {
      const root = makeTempDir('cef-launcher-v3');
      const launcherExe = path.join(root, 'GameLauncher.exe');
      const libcefDll = path.join(root, 'libcef.dll');
      const qtWebDll = path.join(root, 'Qt5WebEngineCore.dll');
      const binDir = path.join(root, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const legacyChildExe = path.join(binDir, 'ClassicGame.exe');

      fs.writeFileSync(
        launcherExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          largeAddressAware: true,
          importedDlls: ['kernel32.dll', 'user32.dll', 'libcef.dll', 'Qt5WebEngineCore.dll'],
        })
      );
      fs.writeFileSync(
        libcefDll,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          isDll: true,
          importedDlls: ['kernel32.dll', 'd3d11.dll', 'dxgi.dll'],
          rdataSize: 0x120000,
          rdataTailStrings: ['d3d11.dll', 'dxgi.dll', 'vulkan-1.dll'],
        })
      );
      fs.writeFileSync(
        qtWebDll,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          isDll: true,
          importedDlls: ['kernel32.dll', 'd3d11.dll', 'dxgi.dll'],
          rdataStrings: ['d3d11.dll', 'dxgi.dll'],
        })
      );
      fs.writeFileSync(
        legacyChildExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x86',
          importedDlls: ['kernel32.dll', 'user32.dll', 'ddraw.dll'],
        })
      );

      const caps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(launcherExe, root);
      expect(caps.isLauncherStubCandidate).toBe(true);
      expect(caps.usesModernGraphicsApi).toBe(false);
      expect(caps.usesLegacyDdraw).toBe(true);
      expect(caps.hasChildGameExecutable).toBe(true);
      expect(caps.targetExePaths).toContain(legacyChildExe);
      expect(caps.targetExeBasenamesLower).toContain('classicgame.exe');
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(caps, 'auto_fullscreen')
      ).toBe(true);
    });

    it('manages per-exe AppCompatFlags\\Layers HIGHDPIAWARE accurately across DPI-aware manifests, API callers, storefronts, launcher stubs, secondary utilities, unwrapped legacy windowed games, and false-mode token-preserving strip', () => {
      const root = makeTempDir('appcompat-layers-v3');
      const bottleDir = path.join(root, 'Bottle');
      createSyntheticBottleTree(bottleDir, {
        userRegExtra: [
          '[Software\\\\Microsoft\\\\Windows NT\\\\CurrentVersion\\\\AppCompatFlags\\\\Layers]',
          '"medievalrpg.exe"="~ WIN7RTM HIGHDPIAWARE"',
          '',
        ].join('\n'),
      });
      const fakeWineBin = path.join(root, 'CrossOver.app', 'Contents', 'SharedSupport', 'CrossOver', 'bin', 'wine');
      fs.mkdirSync(path.dirname(fakeWineBin), { recursive: true });
      fs.writeFileSync(fakeWineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      // 1. DPI-unaware modern x64 game + secondary utility + discovered child game exe
      const gameDir = path.join(root, 'ModernGame');
      fs.mkdirSync(gameDir, { recursive: true });
      const mainExe = path.join(gameDir, 'MedievalRPG.exe');
      const childGameExe = path.join(gameDir, 'MedievalRPG_Bin64.exe');
      fs.writeFileSync(
        mainExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'd3d11.dll'],
        })
      );
      fs.writeFileSync(
        childGameExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'd3d11.dll'],
        })
      );

      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        mainExe,
        { displayScalingMode: 'auto_fullscreen' },
        {
          platform: 'darwin',
          targetExeNames: ['MedievalRPG.exe', 'MedievalRPG_Bin64.exe', 'Config.exe', 'Steam.exe'],
          installDir: gameDir,
        }
      );
      let reg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(reg).toContain('"medievalrpg.exe"="~ WIN7RTM HIGHDPIAWARE"');
      expect(reg).toContain('"medievalrpg_bin64.exe"="~ HIGHDPIAWARE"');
      // Secondary utility (Config.exe) and storefront client (Steam.exe) MUST NOT receive HIGHDPIAWARE
      expect(reg).not.toContain('"config.exe"');
      expect(reg).not.toContain('"steam.exe"');

      // 2. Explicit crossoverHighResolutionMode === false strips HIGHDPIAWARE while preserving WIN7RTM!
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        mainExe,
        { crossoverHighResolutionMode: false, displayScalingMode: 'auto_fullscreen' },
        {
          platform: 'darwin',
          targetExeNames: ['MedievalRPG.exe', 'MedievalRPG_Bin64.exe'],
          installDir: gameDir,
        }
      );
      reg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(reg).toContain('"medievalrpg.exe"="~ WIN7RTM"');
      expect(reg).not.toContain('"medievalrpg_bin64.exe"');

      // 3. Skip EXEs with <dpiAware> manifest OR SetProcessDpiAwarenessContext import/string
      const dpiAwareManifestExe = path.join(gameDir, 'ManifestAware.exe');
      fs.writeFileSync(
        dpiAwareManifestExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'd3d11.dll'],
          rsrcManifestXml:
            '<assembly><application><windowsSettings><dpiAware>true/pm</dpiAware></windowsSettings></application></assembly>',
        })
      );
      const dpiApiExe = path.join(gameDir, 'ApiAware.exe');
      fs.writeFileSync(
        dpiApiExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'user32.dll', 'd3d11.dll'],
          rdataStrings: ['SetProcessDpiAwarenessContext'],
        })
      );
      const legacyWinExe = path.join(gameDir, 'LegacyWindowed.exe');
      fs.writeFileSync(
        legacyWinExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x86',
          importedDlls: ['kernel32.dll', 'ddraw.dll'],
        })
      );

      const manifestCaps = binaryInspectors.inspectPeCapabilities(dpiAwareManifestExe);
      expect(manifestCaps.hasDpiAwareManifest).toBe(true);
      expect(manifestCaps.declaresPerMonitorDpi).toBe(true);
      const apiCaps = binaryInspectors.inspectPeCapabilities(dpiApiExe);
      expect(apiCaps.callsPerMonitorDpiApi).toBe(true);

      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        dpiAwareManifestExe,
        { displayScalingMode: 'auto_fullscreen' },
        { platform: 'darwin', installDir: gameDir }
      );
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        dpiApiExe,
        { displayScalingMode: 'auto_fullscreen' },
        { platform: 'darwin', installDir: gameDir }
      );
      // Unwrapped legacy 32-bit windowed game must NOT be marked HIGHDPIAWARE
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        legacyWinExe,
        { displayScalingMode: 'windowed' },
        { platform: 'darwin', installDir: gameDir }
      );
      reg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(reg).not.toContain('"manifestaware.exe"');
      expect(reg).not.toContain('"apiaware.exe"');
      expect(reg).not.toContain('"legacywindowed.exe"');
    });

    it('self-heals shared-bottle RetinaMode + Desktop & Fonts LogPixels, heals fresh unmanaged RetinaMode="n", keeps EmulateModeset off in windowed mode, and scopes sanitizeWinePrefixDisplayConfigs cleanly', () => {
      const root = makeTempDir('bottle-heal-v3');
      const bottleDir = path.join(root, 'Bottle');
      createSyntheticBottleTree(bottleDir, {
        userRegExtra: [
          '[Control Panel\\\\Desktop]',
          '"LogPixels"=dword:000000c0',
          '',
          '[Software\\\\Wine\\\\Fonts]',
          '"LogPixels"=dword:000000c0',
          '',
        ].join('\n'),
      });
      const gameExe = path.join(root, 'ModernTitle.exe');
      fs.writeFileSync(
        gameExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'd3d11.dll'],
        })
      );

      // Step 1: Game A disables High Resolution Mode (false) -> writes managed markers + 96 DPI in Desktop AND Fonts
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        gameExe,
        { crossoverHighResolutionMode: false, displayScalingMode: 'windowed' },
        { platform: 'darwin' }
      );
      let reg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(reg).toContain('"RetinaMode"="n"');
      expect(reg).toContain('"OneLauncherManagedRetina"="1"');
      expect(reg).toContain('"OneLauncherPriorRetina"="y"');
      const desktopSec1 = reg.slice(reg.indexOf('[Control Panel\\\\Desktop]'), reg.indexOf('[Software\\\\Wine\\\\Fonts]'));
      const fontsSec1 = reg.slice(reg.indexOf('[Software\\\\Wine\\\\Fonts]'));
      expect(desktopSec1).toContain('"LogPixels"=dword:00000060');
      expect(fontsSec1).toContain('"LogPixels"=dword:00000060');
      // Windowed mode must NOT auto-enable EmulateModeset
      expect(reg).not.toContain('"EmulateModeset"="Y"');

      // Step 2: Game B launches with default (undefined) -> self-heals RetinaMode="y", restores 0xc0 in BOTH Desktop & Fonts, and deletes managed markers
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        gameExe,
        { crossoverHighResolutionMode: undefined, displayScalingMode: 'windowed' },
        { platform: 'darwin' }
      );
      reg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(reg).toContain('"RetinaMode"="y"');
      expect(reg).not.toContain('OneLauncherManagedRetina');
      expect(reg).not.toContain('OneLauncherPriorRetina');
      const desktopSec2 = reg.slice(reg.indexOf('[Control Panel\\\\Desktop]'), reg.indexOf('[Software\\\\Wine\\\\Fonts]'));
      const fontsSec2 = reg.slice(reg.indexOf('[Software\\\\Wine\\\\Fonts]'));
      expect(desktopSec2).toContain('"LogPixels"=dword:000000c0');
      expect(fontsSec2).toContain('"LogPixels"=dword:000000c0');
      expect(reg).not.toContain('"EmulateModeset"="Y"');

      // Step 3: Fresh CrossOver bottle starting with UNMANAGED RetinaMode="n" also heals to "y" + 0xc0!
      const freshBottleDir = path.join(root, 'FreshBottle');
      createSyntheticBottleTree(freshBottleDir, {
        userRegExtra: [
          '[Control Panel\\\\Desktop]',
          '"LogPixels"=dword:00000060',
          '',
          '[Software\\\\Wine\\\\Fonts]',
          '"LogPixels"=dword:00000060',
          '',
        ].join('\n'),
      });
      const freshRegPath = path.join(freshBottleDir, 'user.reg');
      fs.writeFileSync(
        freshRegPath,
        fs.readFileSync(freshRegPath, 'utf8').replace('"RetinaMode"="y"', '"RetinaMode"="n"'),
        'utf8'
      );
      macNativeInstaller.applyCrossOverPerGameSettings(
        freshBottleDir,
        gameExe,
        { crossoverHighResolutionMode: undefined, displayScalingMode: 'auto_fullscreen' },
        { platform: 'darwin' }
      );
      const freshReg = fs.readFileSync(freshRegPath, 'utf8');
      expect(freshReg).toContain('"RetinaMode"="y"');
      expect(freshReg).toContain('"LogPixels"=dword:000000c0');
      expect(freshReg).not.toContain('OneLauncherManagedRetina');

      // Step 4: sanitizeWinePrefixDisplayConfigs scopes RetinaMode="n" strictly to [Software\\Wine\\Mac Driver]
      const scopedBottleDir = path.join(root, 'ScopedBottle');
      createSyntheticBottleTree(scopedBottleDir, {
        userRegExtra: [
          '[Software\\\\SomeOtherVendor\\\\Display]',
          '"RetinaMode"="n"',
          '',
        ].join('\n'),
      });
      const cfgPath = path.join(scopedBottleDir, 'drive_c', 'users', 'crossover', 'Saved Games', 'video.cfg');
      fs.writeFileSync(cfgPath, 'r_width = 2560\nr_height = 1440\n', 'utf8');
      const sanRes = macNativeInstaller.sanitizeWinePrefixDisplayConfigs(scopedBottleDir, {
        maxWidth: 3024,
        maxHeight: 1964,
        logicalWidth: 1512,
        logicalHeight: 982,
        displayScalingMode: 'windowed',
      });
      // Because [Software\\Wine\\Mac Driver] has RetinaMode="y", maxWidth stays 3024 (not falsely downgraded by SomeOtherVendor)
      expect(sanRes.maxWidth).toBe(3024);
      expect(sanRes.sanitizedFiles.length).toBe(0);
    });

    it('parses Apple Silicon system_profiler keys, More Space backing buffers, multi-display main selection, and 10s TTL + forceRefresh in getHostMaxDisplayResolution and verify-display-output.cjs', () => {
      const appleSiliconDefaultJson = JSON.stringify({
        SPDisplaysDataType: [
          {
            spdisplays_ndrvs: [
              {
                _name: 'External HDMI 1080p',
                _spdisplays_pixels: '1920 x 1080',
                _spdisplays_resolution: '1920 x 1080 @ 60.00Hz',
                spdisplays_main: 'spdisplays_no',
                spdisplays_online: 'spdisplays_yes',
              },
              {
                _name: 'Color LCD',
                _spdisplays_pixels: '3024 x 1964',
                _spdisplays_resolution: '1512 x 982 @ 120.00Hz',
                spdisplays_pixelresolution: 'spdisplays_3024x1964Retina',
                spdisplays_display_type: 'spdisplays_built-in-liquid-retina-xdr',
                spdisplays_main: 'spdisplays_yes',
                spdisplays_online: 'spdisplays_yes',
              },
            ],
          },
        ],
      });

      const appleSiliconMoreSpaceJson = JSON.stringify({
        SPDisplaysDataType: [
          {
            spdisplays_ndrvs: [
              {
                _name: 'Color LCD',
                _spdisplays_pixels: '3024 x 1964',
                _spdisplays_resolution: '1800 x 1169 @ 120.00Hz',
                spdisplays_pixelresolution: 'spdisplays_3024x1964Retina',
                spdisplays_display_type: 'spdisplays_built-in-liquid-retina-xdr',
                spdisplays_main: 'spdisplays_yes',
                spdisplays_online: 'spdisplays_yes',
              },
            ],
          },
        ],
      });

      // Multi-display: index 0 is external 1x, index 1 is main 2x Retina -> MUST select index 1
      const hostDefault = macNativeInstaller.getHostMaxDisplayResolution(true, {
        execFileSyncFn: () => appleSiliconDefaultJson,
      });
      expect(hostDefault.width).toBe(3024);
      expect(hostDefault.height).toBe(1964);
      expect(hostDefault.logicalWidth).toBe(1512);
      expect(hostDefault.logicalHeight).toBe(982);
      expect(hostDefault.panelWidth).toBe(3024);
      expect(hostDefault.panelHeight).toBe(1964);

      const verifierDefault = verifyDisplayOutput.detectDisplayGeometry({
        platform: 'darwin',
        execSyncFn: () => appleSiliconDefaultJson,
      });
      expect(verifierDefault.width).toBe(3024);
      expect(verifierDefault.height).toBe(1964);
      expect(verifierDefault.logicalWidth).toBe(1512);
      expect(verifierDefault.logicalHeight).toBe(982);
      expect(verifierDefault.isMain).toBe(true);

      // "More Space" scaled preset (1800x1169 UI on 3024x1964 panel -> 3600x2338 backing!)
      const hostMoreSpace = macNativeInstaller.getHostMaxDisplayResolution(true, {
        execFileSyncFn: () => appleSiliconMoreSpaceJson,
      });
      expect(hostMoreSpace.width).toBe(3600);
      expect(hostMoreSpace.height).toBe(2338);
      expect(hostMoreSpace.logicalWidth).toBe(1800);
      expect(hostMoreSpace.logicalHeight).toBe(1169);
      expect(hostMoreSpace.panelWidth).toBe(3024);
      expect(hostMoreSpace.panelHeight).toBe(1964);

      const verifierMoreSpace = verifyDisplayOutput.detectDisplayGeometry({
        platform: 'darwin',
        execSyncFn: () => appleSiliconMoreSpaceJson,
      });
      expect(verifierMoreSpace.width).toBe(3600);
      expect(verifierMoreSpace.height).toBe(2338);
      expect(verifierMoreSpace.logicalWidth).toBe(1800);
      expect(verifierMoreSpace.logicalHeight).toBe(1169);
      expect(verifierMoreSpace.panelWidth).toBe(3024);
      expect(verifierMoreSpace.panelHeight).toBe(1964);

      // 10s TTL caching + forceRefresh verification
      let probeCalls = 0;
      const probeMock = () => {
        probeCalls += 1;
        return probeCalls === 1 ? appleSiliconDefaultJson : appleSiliconMoreSpaceJson;
      };
      const t0 = macNativeInstaller.getHostMaxDisplayResolution(true, {
        execFileSyncFn: probeMock,
        useCacheWithProbeFn: true,
        forceRefresh: true,
        nowMs: 1_000_000,
      });
      expect(t0.width).toBe(3024);
      expect(probeCalls).toBe(1);
      // Within 10s TTL -> cached hit
      const t1 = macNativeInstaller.getHostMaxDisplayResolution(true, {
        execFileSyncFn: probeMock,
        useCacheWithProbeFn: true,
        nowMs: 1_005_000,
      });
      expect(t1.width).toBe(3024);
      expect(probeCalls).toBe(1);
      // Beyond 10s TTL -> re-probes
      const t2 = macNativeInstaller.getHostMaxDisplayResolution(true, {
        execFileSyncFn: probeMock,
        useCacheWithProbeFn: true,
        nowMs: 1_015_000,
      });
      expect(t2.width).toBe(3600);
      expect(probeCalls).toBe(2);
      // forceRefresh immediately re-probes within TTL
      const t3 = macNativeInstaller.getHostMaxDisplayResolution(true, {
        execFileSyncFn: probeMock,
        useCacheWithProbeFn: true,
        forceRefresh: true,
        nowMs: 1_016_000,
      });
      expect(t3.width).toBe(3600);
      expect(probeCalls).toBe(3);
    });

    it('forwards SIP-protected scaler keys in CX_ENV, signs macOS bundles inside-out without --deep, uses x64 --watch-dir for 64-bit toggles, preserves empty-HOME & Windows/macOS path portability, and exposes expanded Virtual Desktop presets', async () => {
      const root = makeTempDir('cx-codesign-portability-v3');
      const fakeCxRoot = path.join(root, 'CrossOver.app', 'Contents', 'SharedSupport', 'CrossOver');
      const fakeWineBin = path.join(fakeCxRoot, 'bin', 'wine');
      fs.mkdirSync(path.dirname(fakeWineBin), { recursive: true });
      fs.writeFileSync(fakeWineBin, '#!/usr/bin/perl\nexit 0;\n', { mode: 0o755 });

      // 1. CX_ENV forwarding of ONE_LAUNCHER_SCALING_FILTER, ONE_LAUNCHER_DISPLAY_TRACE_FILE, ONE_LAUNCHER_SINGLE_CORE_AFFINITY
      const spawnEnv: Record<string, string> = {
        ONE_LAUNCHER_SCALING_FILTER: 'sharp',
        ONE_LAUNCHER_DISPLAY_TRACE_FILE: 'C:\\users\\Public\\trace.log',
        ONE_LAUNCHER_SINGLE_CORE_AFFINITY: '1',
      };
      macNativeInstaller.prepareCrossOverWineSpawnEnv(fakeWineBin, spawnEnv, {
        platform: 'darwin',
      });
      const cxEnv = String(spawnEnv.CX_ENV || '');
      expect(cxEnv).toContain('ONE_LAUNCHER_SCALING_FILTER');
      expect(cxEnv).toContain('ONE_LAUNCHER_DISPLAY_TRACE_FILE');
      expect(cxEnv).toContain('ONE_LAUNCHER_SINGLE_CORE_AFFINITY');

      // 2. Inside-out codesign (sync + async) NEVER passes --deep to codesign --sign
      const appDir = path.join(root, 'SyntheticRunner.app');
      const macOsDir = path.join(appDir, 'Contents', 'MacOS');
      const fwDir = path.join(appDir, 'Contents', 'Frameworks');
      fs.mkdirSync(macOsDir, { recursive: true });
      fs.mkdirSync(fwDir, { recursive: true });
      const machOHeader = Buffer.alloc(64, 0);
      machOHeader.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
      const nestedDylib = path.join(fwDir, 'libhelper.dylib');
      const mainExec = path.join(macOsDir, 'SyntheticRunner');
      fs.writeFileSync(nestedDylib, machOHeader);
      fs.writeFileSync(mainExec, machOHeader);
      fs.writeFileSync(
        path.join(appDir, 'Contents', 'Info.plist'),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.synth.runner</string></dict></plist>',
        'utf8'
      );

      const syncInvocations: Array<{ cmd: string; args: string[] }> = [];
      let syncVerifiedOnce = false;
      const syncSignRes = macNativeInstaller.ensureMacAppCodeSignatureValid(appDir, {
        platform: 'darwin',
        allowCodesignInTest: true,
        forceCodesignRecheck: true,
        execFileSyncFn: (cmd: string, args: string[]) => {
          syncInvocations.push({ cmd, args: [...args] });
          if (cmd === 'codesign' && args.includes('--verify') && !syncVerifiedOnce) {
            syncVerifiedOnce = true;
            throw new Error('unsigned');
          }
          return '';
        },
      });
      expect(syncSignRes.verified).toBe(true);
      expect(syncSignRes.repaired).toBe(true);
      const syncSignCalls = syncInvocations.filter(
        (c) => c.cmd === 'codesign' && c.args.includes('--sign')
      );
      expect(syncSignCalls.length).toBeGreaterThanOrEqual(3);
      for (const call of syncSignCalls) {
        expect(call.args).not.toContain('--deep');
      }
      // Nested dylib must be signed BEFORE the outer .app bundle
      const dylibIdx = syncSignCalls.findIndex((c) => c.args.includes(nestedDylib));
      const outerIdx = syncSignCalls.findIndex((c) => c.args[c.args.length - 1] === appDir);
      expect(dylibIdx).toBeGreaterThanOrEqual(0);
      expect(outerIdx).toBeGreaterThan(dylibIdx);

      const asyncInvocations: Array<{ cmd: string; args: string[] }> = [];
      let asyncVerifiedOnce = false;
      const asyncSignRes = await macNativeInstaller.ensureMacAppCodeSignatureValidAsync(appDir, {
        platform: 'darwin',
        allowCodesignInTest: true,
        forceCodesignRecheck: true,
        execFileImpl: (
          cmd: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null) => void
        ) => {
          asyncInvocations.push({ cmd, args: [...args] });
          if (cmd === 'codesign' && args.includes('--verify') && !asyncVerifiedOnce) {
            asyncVerifiedOnce = true;
            cb(new Error('unsigned'));
            return;
          }
          cb(null);
        },
      });
      expect(asyncSignRes.verified).toBe(true);
      expect(asyncSignRes.repaired).toBe(true);
      const asyncSignCalls = asyncInvocations.filter(
        (c) => c.cmd === 'codesign' && c.args.includes('--sign')
      );
      expect(asyncSignCalls.length).toBeGreaterThanOrEqual(3);
      for (const call of asyncSignCalls) {
        expect(call.args).not.toContain('--deep');
      }

      // 3. Empty-HOME & Windows backslash vs macOS slash path separator portability
      const emptyHome = makeTempDir('empty-home-v3');
      const portableBottle = path.join(emptyHome, 'PortableBottle');
      createSyntheticBottleTree(portableBottle);
      const prevHome = process.env.HOME;
      try {
        process.env.HOME = '';
        macNativeInstaller.applyCrossOverPerGameSettings(
          portableBottle,
          'C:\\Games\\Studio\\Bin\\Portable64.exe',
          { displayScalingMode: 'auto_fullscreen' },
          { platform: 'darwin', homedir: emptyHome }
        );
      } finally {
        if (prevHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = prevHome;
        }
      }
      const portableReg = fs.readFileSync(path.join(portableBottle, 'user.reg'), 'utf8');
      expect(portableReg).toContain('"RetinaMode"="y"');
      expect(portableReg).toContain('"portable64.exe"="~ HIGHDPIAWARE"');

      // 4. Expanded Virtual Desktop presets + accurate X11 Driver EmulateModeset hint
      const vdValues = VIRTUAL_DESKTOP_RESOLUTION_OPTIONS.map((o) => o.value);
      for (const expectedPreset of [
        'auto',
        '3840x2160',
        '3456x2234',
        '3440x1440',
        '3024x1964',
        '2560x1600',
        '2560x1440',
        '1920x1080',
        '1728x1117',
        '1512x982',
      ]) {
        expect(vdValues).toContain(expectedPreset);
      }
      const repoRoot = path.resolve(__dirname, '..');
      const compatSrc = fs.readFileSync(
        path.join(repoRoot, 'src/components/Launcher/LaunchConfig/CompatibilityLayerSection.tsx'),
        'utf8'
      );
      expect(compatSrc).toContain('X11 Driver\\EmulateModeset');

      // 5. Arch-matched --watch-dir launcher selection (x64 for 64-bit sessions) in toggleSessionFullscreen
      const homedir64 = path.join(root, 'home64');
      const appsDir64 = path.join(root, 'Applications64');
      const fakeWineBin64 = path.join(
        appsDir64,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin',
        'wine'
      );
      fs.mkdirSync(path.dirname(fakeWineBin64), { recursive: true });
      fs.writeFileSync(fakeWineBin64, '#!/usr/bin/perl\nexit 0;\n', { mode: 0o755 });
      const bottle64 = path.join(
        homedir64,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'Bottle64'
      );
      createSyntheticBottleTree(bottle64);
      const game64Dir = path.join(root, 'Game64');
      fs.mkdirSync(game64Dir, { recursive: true });
      const game64Exe = path.join(game64Dir, 'Modern64.exe');
      fs.writeFileSync(
        game64Exe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'd3d11.dll'],
        })
      );
      const watcherSpawns: Array<{ cmd: string; args: string[] }> = [];
      const child64 = createFakeChildProcess(62202);
      const launch64 = await supervisor.launchGame(
        {
          gameId: 'gog-watchdir-x64',
          title: 'Modern64 WatchDir Test',
          platformId: 'gog',
          platformGameId: '1000000888',
          installPath: game64Dir,
          executablePath: game64Exe,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            wineBottleName: 'Bottle64',
            winePrefixPath: bottle64,
            displayScalingMode: 'auto_fullscreen',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: homedir64,
          userDataDir: path.join(root, 'UserData64'),
          customApplicationsDir: appsDir64,
          enableDisplayScalerInTests: true,
          skipRegistrySpawn: true,
          gameSpawnFn: (cmd: string, args: string[]) => {
            watcherSpawns.push({ cmd, args: [...args] });
            return child64;
          },
        }
      );
      expect(launch64.success).toBe(true);
      const toggleRes = supervisor.toggleSessionFullscreen(
        { gameId: 'gog-watchdir-x64', fullscreen: true },
        {
          platform: 'darwin',
          enableDisplayScalerInTests: true,
          spawnFn: (cmd: string, args: string[]) => {
            watcherSpawns.push({ cmd, args: [...args] });
            return createFakeChildProcess(62203);
          },
        }
      );
      expect(toggleRes.success).toBe(true);
      const watchDirCall = watcherSpawns.find((s) => s.args.includes('--watch-dir'));
      expect(watchDirCall).toBeDefined();
      expect(watchDirCall?.args.join(' ')).toContain('one_display_launcher_x64.exe');
      expect(watchDirCall?.args.join(' ')).not.toContain('one_display_launcher_x86.exe');
      await supervisor.finalizeGameSession('gog-watchdir-x64', {
        platform: 'darwin',
        userDataDir: path.join(root, 'UserData64'),
      });

      // 6. Native libone_coop_activate.dylib Node-API addon smoke check (0-arg & scoped options)
      if (process.platform === 'darwin') {
        const dylibPath = path.join(repoRoot, 'electron/helpers/libone_coop_activate.dylib');
        if (fs.existsSync(dylibPath)) {
          const mod = { exports: {} as Record<string, any> };
          process.dlopen(mod, dylibPath);
          expect(typeof mod.exports.pollAndActivateBottledGame).toBe('function');
          const resZeroArg = Number(mod.exports.pollAndActivateBottledGame());
          const resScoped = Number(
            mod.exports.pollAndActivateBottledGame({
              rootPid: process.pid,
              targetExeNames: ['SyntheticGame.exe'],
            })
          );
          expect(Number.isFinite(resZeroArg) && resZeroArg >= 0).toBe(true);
          expect(Number.isFinite(resScoped) && resScoped >= 0).toBe(true);
        }
      }
    });

    it('covers Round 2 hardening: toggleSessionFullscreen windowed active_session.ini mode, dynamic DXGI+DX12 chunk-2 scan, XML-namespaced DPI manifests, 64-bit multi-renderer bypass, Larger Text/5K HiDPI backing, inside-out Helpers Mach-O / Java .class / bundleId hygiene, and mode=off legacy HIGHDPIAWARE exclusion', async () => {
      const root = makeTempDir('round2-hardening');

      // 1. F7: Dynamic DXGI in chunk 1 + DX12 in chunk 2 (>256 KiB offset) MUST NOT short-circuit before finding d3d12.dll!
      const dx12Exe = path.join(root, 'DynamicDx12.exe');
      fs.writeFileSync(
        dx12Exe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'user32.dll'],
          rdataSize: 0x100000,
          rdataStrings: ['dxgi.dll', 'CreateDXGIFactory'],
          rdataTailStrings: ['d3d12.dll', 'D3D12CreateDevice'],
        })
      );
      const dx12Caps = binaryInspectors.inspectPeCapabilities(dx12Exe);
      expect(dx12Caps.dynamicallyLoadsDxgi).toBe(true);
      expect(dx12Caps.dynamicallyLoadsD3d12).toBe(true);
      expect(dx12Caps.importsD3d12).toBe(true);
      expect(dx12Caps.isD3d12Only).toBe(true);

      // 2. F7: XML-namespaced DPI manifests (<asmv3:dpiAware> and <ws2:dpiAwareness>) detected cleanly
      const nsManifestExe = path.join(root, 'NamespacedDpi.exe');
      fs.writeFileSync(
        nsManifestExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'd3d11.dll'],
          rsrcManifestXml:
            '<assembly><asmv3:application><asmv3:windowsSettings><asmv3:dpiAware>true/pm</asmv3:dpiAware><ws2:dpiAwareness>PerMonitorV2</ws2:dpiAwareness></asmv3:windowsSettings></asmv3:application></assembly>',
        })
      );
      const nsCaps = binaryInspectors.inspectPeCapabilities(nsManifestExe);
      expect(nsCaps.hasDpiAwareManifest).toBe(true);
      expect(nsCaps.declaresPerMonitorDpi).toBe(true);

      // 3. F7: 64-bit multi-renderer UE4-style binary (d3d11 + opengl32) is modern 64-bit host unless -opengl4 is passed
      const multiDir = path.join(root, 'MultiRenderer64');
      fs.mkdirSync(multiDir, { recursive: true });
      const multiExe = path.join(multiDir, 'Multi64-Win64-Shipping.exe');
      fs.writeFileSync(
        multiExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'd3d11.dll', 'opengl32.dll'],
        })
      );
      const multiCaps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(multiExe, multiDir);
      expect(multiCaps.usesModernGraphicsApi).toBe(true);
      expect(multiCaps.isLauncherStubCandidate).toBe(false);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(multiCaps, 'auto_fullscreen', '')
      ).toBe(false);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(multiCaps, 'auto_fullscreen', '-opengl4')
      ).toBe(true);

      // 4. F8: macOS HiDPI "Larger Text" (1352x878 -> 2704x1756), 5K 1080p HiDPI (1920x1080 -> 3840x2160), and 1x Native (3024x1964 -> 3024x1964)
      const largerTextJson = JSON.stringify({
        SPDisplaysDataType: [
          {
            spdisplays_ndrvs: [
              {
                _name: 'Color LCD',
                _spdisplays_pixels: '3024 x 1964',
                _spdisplays_resolution: '1352 x 878 @ 120.00Hz',
                spdisplays_pixelresolution: 'spdisplays_3024x1964Retina',
                spdisplays_main: 'spdisplays_yes',
                spdisplays_online: 'spdisplays_yes',
              },
            ],
          },
        ],
      });
      const fiveKScaledJson = JSON.stringify({
        SPDisplaysDataType: [
          {
            spdisplays_ndrvs: [
              {
                _name: 'Studio Display',
                _spdisplays_pixels: '5120 x 2880',
                _spdisplays_resolution: '1920 x 1080 @ 60.00Hz',
                spdisplays_retina: 'spdisplays_yes',
                spdisplays_main: 'spdisplays_yes',
                spdisplays_online: 'spdisplays_yes',
              },
            ],
          },
        ],
      });
      const native1xJson = JSON.stringify({
        SPDisplaysDataType: [
          {
            spdisplays_ndrvs: [
              {
                _name: 'Color LCD',
                _spdisplays_pixels: '3024 x 1964',
                _spdisplays_resolution: '3024 x 1964 @ 120.00Hz',
                spdisplays_pixelresolution: 'spdisplays_3024x1964Retina',
                spdisplays_main: 'spdisplays_yes',
                spdisplays_online: 'spdisplays_yes',
              },
            ],
          },
        ],
      });

      const hostLT = macNativeInstaller.getHostMaxDisplayResolution(true, {
        execFileSyncFn: () => largerTextJson,
      });
      expect(hostLT.width).toBe(2704);
      expect(hostLT.height).toBe(1756);
      expect(hostLT.logicalWidth).toBe(1352);
      expect(hostLT.panelWidth).toBe(3024);

      const verLT = verifyDisplayOutput.detectDisplayGeometry({
        platform: 'darwin',
        execSyncFn: () => largerTextJson,
      });
      expect(verLT.width).toBe(2704);
      expect(verLT.height).toBe(1756);

      const host5K = macNativeInstaller.getHostMaxDisplayResolution(true, {
        execFileSyncFn: () => fiveKScaledJson,
      });
      expect(host5K.width).toBe(3840);
      expect(host5K.height).toBe(2160);
      expect(host5K.panelWidth).toBe(5120);

      const host1x = macNativeInstaller.getHostMaxDisplayResolution(true, {
        execFileSyncFn: () => native1xJson,
      });
      expect(host1x.width).toBe(3024);
      expect(host1x.height).toBe(1964);

      // 5. F9: Inside-out codesign signs extensionless Mach-O in Contents/Helpers, rejects Java .class 0xCAFEBABE, and sanitizes quoted bundleId
      const appDir = path.join(root, 'HelperHardened.app');
      const macOsDir = path.join(appDir, 'Contents', 'MacOS');
      const helpersDir = path.join(appDir, 'Contents', 'Helpers');
      fs.mkdirSync(macOsDir, { recursive: true });
      fs.mkdirSync(helpersDir, { recursive: true });
      const machO64 = Buffer.alloc(64, 0);
      machO64.writeUInt32BE(0xfeedfacf, 0);
      const fatMachO = Buffer.alloc(64, 0);
      fatMachO.writeUInt32BE(0xcafebabe, 0);
      fatMachO.writeUInt32BE(2, 4); // nfat_arch = 2 (valid Mach-O universal)
      const javaClass = Buffer.alloc(64, 0);
      javaClass.writeUInt32BE(0xcafebabe, 0);
      javaClass.writeUInt16BE(0, 4); // minor = 0
      javaClass.writeUInt16BE(52, 6); // major = 52 (Java 8 .class -> uint32 BE = 52 > 32!)
      const helperExec = path.join(helpersDir, 'chrome_crashpad_handler');
      const javaClassPath = path.join(helpersDir, 'Fake.class');
      fs.writeFileSync(path.join(macOsDir, 'HelperHardened'), machO64);
      fs.writeFileSync(helperExec, fatMachO);
      fs.writeFileSync(javaClassPath, javaClass);
      fs.writeFileSync(
        path.join(appDir, 'Contents', 'Info.plist'),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.bad"quote.id</string></dict></plist>',
        'utf8'
      );
      const signCalls: string[][] = [];
      let failedVerify = false;
      macNativeInstaller.ensureMacAppCodeSignatureValid(appDir, {
        platform: 'darwin',
        allowCodesignInTest: true,
        forceCodesignRecheck: true,
        execFileSyncFn: (cmd: string, args: string[]) => {
          if (cmd === 'codesign' && args.includes('--verify') && !failedVerify) {
            failedVerify = true;
            throw new Error('unsigned');
          }
          if (cmd === 'codesign' && args.includes('--sign')) {
            signCalls.push([...args]);
          }
          return '';
        },
      });
      // Extensionless Fat Mach-O in Contents/Helpers WAS signed; Java .class was NOT signed!
      expect(signCalls.some((a) => a.includes(helperExec))).toBe(true);
      expect(signCalls.some((a) => a.includes(javaClassPath))).toBe(false);
      // Malformed bundleId with quote MUST NOT be interpolated into -r=designated
      expect(signCalls.some((a) => a.some((tok) => tok.includes('com.bad')))).toBe(false);

      // 6. F11: Legacy 32-bit game in displayScalingMode === 'off' MUST NOT receive HIGHDPIAWARE
      const bottleOff = path.join(root, 'BottleOff');
      createSyntheticBottleTree(bottleOff);
      const legacyOffExe = path.join(root, 'LegacyOff32.exe');
      fs.writeFileSync(
        legacyOffExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x86',
          importedDlls: ['kernel32.dll', 'ddraw.dll'],
        })
      );
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleOff,
        legacyOffExe,
        { displayScalingMode: 'off' },
        { platform: 'darwin' }
      );
      const offReg = fs.readFileSync(path.join(bottleOff, 'user.reg'), 'utf8');
      expect(offReg).not.toContain('"legacyoff32.exe"="~ HIGHDPIAWARE"');

      // 7. F2: toggleSessionFullscreen({ fullscreen: false }) writes mode=auto_fullscreen (NOT mode=windowed)
      //    so late-injected --watch-dir scaler initializes and honors display_ctl seq=2, fullscreen=0
      const homedirF2 = path.join(root, 'homeF2');
      const appsDirF2 = path.join(root, 'AppsF2');
      const wineBinF2 = path.join(
        appsDirF2,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin',
        'wine'
      );
      fs.mkdirSync(path.dirname(wineBinF2), { recursive: true });
      fs.writeFileSync(wineBinF2, '#!/usr/bin/perl\nexit 0;\n', { mode: 0o755 });
      const bottleF2 = path.join(
        homedirF2,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'BottleF2'
      );
      createSyntheticBottleTree(bottleF2);
      const gameF2Dir = path.join(root, 'GameF2');
      fs.mkdirSync(gameF2Dir, { recursive: true });
      const gameF2Exe = path.join(gameF2Dir, 'ModernF2.exe');
      fs.writeFileSync(
        gameF2Exe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'd3d11.dll'],
        })
      );
      const f2Spawns: Array<{ args: string[]; env: Record<string, string> }> = [];
      const launchF2 = await supervisor.launchGame(
        {
          gameId: 'gog-f2-windowed-toggle',
          title: 'Modern F2 Toggle Test',
          platformId: 'gog',
          platformGameId: '1000000991',
          installPath: gameF2Dir,
          executablePath: gameF2Exe,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            wineBottleName: 'BottleF2',
            winePrefixPath: bottleF2,
            displayScalingMode: 'auto_fullscreen',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: homedirF2,
          userDataDir: path.join(root, 'UserDataF2'),
          customApplicationsDir: appsDirF2,
          enableDisplayScalerInTests: true,
          skipRegistrySpawn: true,
          gameSpawnFn: (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
            void cmd;
            f2Spawns.push({ args: [...args], env: { ...(opts?.env || {}) } });
            return createFakeChildProcess(62301);
          },
        }
      );
      expect(launchF2.success).toBe(true);
      const toggleWinRes = supervisor.toggleSessionFullscreen(
        { gameId: 'gog-f2-windowed-toggle', fullscreen: false },
        {
          platform: 'darwin',
          enableDisplayScalerInTests: true,
          spawnFn: (_cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
            f2Spawns.push({ args: [...args], env: { ...(opts?.env || {}) } });
            return createFakeChildProcess(62302);
          },
        }
      );
      expect(toggleWinRes.success).toBe(true);
      expect(toggleWinRes.fullscreenActive).toBe(false);
      const watchSpawnF2 = f2Spawns.find((s) => s.args.includes('--watch-dir'));
      expect(watchSpawnF2).toBeDefined();
      expect(watchSpawnF2?.env.ONE_LAUNCHER_DISPLAY_SCALING_MODE).toBe('auto_fullscreen');
      const activeIniF2 = fs.readFileSync(
        path.join(bottleF2, 'drive_c', 'ProgramData', 'OneLauncher', 'display_scaler', 'active_session.ini'),
        'utf8'
      );
      expect(activeIniF2).toContain('mode=auto_fullscreen');
      expect(activeIniF2).not.toContain('mode=windowed');
      await supervisor.finalizeGameSession('gog-f2-windowed-toggle', {
        platform: 'darwin',
        userDataDir: path.join(root, 'UserDataF2'),
      });
    });

    it('Round 3 Universal Fixes (L1 UE4/UE5 depth-3 discovery, L3 8 MiB .rdata scan, L4 .NET GOG launcher stub bypass, R2-3 -opengl4 parity)', async () => {
      const root = makeTempDir('display-scaler-round3-fixes');
      const binaryInspectors = requireCjs('../electron/launcher/binaryAndManifestInspectors.cjs') as {
        inspectPeCapabilities: (exePath: string, opts?: Record<string, unknown>) => Record<string, any>;
        resolveEffectiveGameExecutableCapabilities: (
          exePath: string,
          installDir: string,
          opts?: Record<string, unknown>
        ) => Record<string, any>;
        selectPreferredGogPlayTask: (
          playTasks: Array<Record<string, unknown>>,
          searchDirs?: string[],
          opts?: Record<string, unknown>
        ) => Record<string, any> | null;
      };
      const installedScanner = requireCjs('../electron/launcher/installedGameScanner.cjs') as {
        scanAllInstalledGames: (opts?: Record<string, unknown>) => Promise<{
          success: boolean;
          installedGames: Array<Record<string, any>>;
        }>;
      };
      const macNativeInstaller = requireCjs('../electron/launcher/macNativeInstallerAndCodesign.cjs') as {
        findPrimaryExecutable: (dir: string, opts?: Record<string, unknown>) => {
          executablePath?: string;
          isWindowsBinaryOnMac?: boolean;
        };
      };
      const supervisor = requireCjs('../electron/launcher/sessionAndProcessSupervisor.cjs') as {
        collectChainedGameCandidateExeNames: (installPath: string, primaryExe?: string) => string[];
        shouldWrapBottleSessionWithDisplayLauncher: (
          caps: Record<string, unknown>,
          mode: string,
          launchArgsStr?: string
        ) => boolean;
        launchGame: (payload: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<Record<string, any>>;
        finalizeGameSession: (gameId: string, opts?: Record<string, unknown>) => Promise<unknown>;
      };

      // 1. L1: UE4/UE5 depth-3 `<Project>/Binaries/Win64/*-Shipping.exe` discovery despite 500+ dummy files in Engine/ & Content/Paks/
      const ue4Dir = path.join(root, 'Ue4GameRoot');
      const engineDir = path.join(ue4Dir, 'Engine', 'Binaries', 'ThirdParty');
      const paksDir = path.join(ue4Dir, 'RootGame', 'Content', 'Paks');
      const shipDir = path.join(ue4Dir, 'RootGame', 'Binaries', 'Win64');
      fs.mkdirSync(engineDir, { recursive: true });
      fs.mkdirSync(paksDir, { recursive: true });
      fs.mkdirSync(shipDir, { recursive: true });
      for (let i = 0; i < 300; i += 1) {
        fs.writeFileSync(path.join(engineDir, `eng_${String(i).padStart(3, '0')}.dat`), 'x');
      }
      for (let i = 0; i < 200; i += 1) {
        fs.writeFileSync(path.join(paksDir, `pak_${String(i).padStart(3, '0')}.pak`), 'y');
      }
      const rootStubExe = path.join(ue4Dir, 'RootGame.exe');
      const shippingExe = path.join(shipDir, 'RootGame-Win64-Shipping.exe');
      fs.writeFileSync(
        rootStubExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'user32.dll', 'shell32.dll'],
        })
      );
      fs.writeFileSync(
        shippingExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'user32.dll', 'd3d11.dll', 'dxgi.dll', 'opengl32.dll'],
        })
      );

      const ue4Caps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(rootStubExe, ue4Dir);
      expect(ue4Caps.usesModernGraphicsApi).toBe(true);
      expect(ue4Caps.hasDpiAwareManifest).toBe(false);
      expect(ue4Caps.hasChildGameExecutable).toBe(true);
      expect(ue4Caps.targetExePaths.map((p: string) => path.resolve(p))).toContain(path.resolve(shippingExe));
      expect(ue4Caps.targetExeBasenamesLower).toContain('rootgame-win64-shipping.exe');
      expect(ue4Caps.targetExeBasenamesLower).toContain('rootgame.exe');

      const chainedNames = supervisor.collectChainedGameCandidateExeNames(ue4Dir, rootStubExe);
      expect(chainedNames).toContain('rootgame-win64-shipping.exe');

      // 2. L3: Large 8 MiB `.rdata` engine DLL with D3D11/DXGI strings at +5.0 MiB offset
      const bigDllPath = path.join(root, 'BigEngine64.dll');
      const bigDllBuf = buildExtendedSyntheticPeBuffer({
        arch: 'x64',
        isDll: true,
        importedDlls: ['kernel32.dll', 'user32.dll'],
        rdataSize: 8 * 1024 * 1024,
      });
      // `.rdata` begins at file offset 0x200; place markers at +5.0 MiB inside `.rdata` (past old 4 MiB cap)
      const markerOffset = 0x200 + 5 * 1024 * 1024;
      bigDllBuf.write('dxgi.dll\0d3d11.dll\0D3D11CreateDevice\0CreateDXGIFactory\0', markerOffset, 'latin1');
      fs.writeFileSync(bigDllPath, bigDllBuf);
      const bigDllCaps = binaryInspectors.inspectPeCapabilities(bigDllPath);
      expect(bigDllCaps.dynamicallyLoadsDxgi).toBe(true);
      expect(bigDllCaps.dynamicallyLoadsD3d11).toBe(true);
      expect(bigDllCaps.importsD3d11Or10).toBe(true);

      // 3. L4: GOG `.NET` (`mscoree.dll`) launcher stub bypassed universally (NO `GOGLauncher.exe` on disk),
      //    preferring non-hidden `category: "game"`, while native Win32 launchers are NOT falsely bypassed.
      const gogRoot = path.join(root, 'GogLibrary');
      const gogDotNetDir = path.join(gogRoot, 'ClassicDotNetGame');
      fs.mkdirSync(gogDotNetDir, { recursive: true });
      const dotNetLauncherExe = path.join(gogDotNetDir, 'GameLauncher.exe');
      const classicGameExe = path.join(gogDotNetDir, 'gamew.exe');
      const hiddenHrExe = path.join(gogDotNetDir, 'gamewHR.exe');
      fs.writeFileSync(
        dotNetLauncherExe,
        buildExtendedSyntheticPeBuffer({ arch: 'x86', importedDlls: ['mscoree.dll'] })
      );
      fs.writeFileSync(
        classicGameExe,
        buildExtendedSyntheticPeBuffer({ arch: 'x86', importedDlls: ['kernel32.dll', 'ddraw.dll'] })
      );
      fs.writeFileSync(
        hiddenHrExe,
        buildExtendedSyntheticPeBuffer({ arch: 'x86', importedDlls: ['kernel32.dll', 'ddraw.dll'] })
      );
      const dotNetPlayTasks = [
        { category: 'launcher', isPrimary: true, name: 'Launcher', path: 'GameLauncher.exe', type: 'FileTask' },
        { category: 'game', name: 'Classic Game', path: 'gamew.exe', type: 'FileTask' },
        { category: 'game', isHidden: true, name: 'Classic HR', path: 'gamewHR.exe', type: 'FileTask' },
      ];
      fs.writeFileSync(
        path.join(gogDotNetDir, 'goggame-123456.info'),
        JSON.stringify({
          gameId: '123456',
          name: 'Classic DotNet Game',
          playTasks: dotNetPlayTasks,
        }),
        'utf8'
      );

      const pickedDotNet = binaryInspectors.selectPreferredGogPlayTask(
        dotNetPlayTasks,
        [gogDotNetDir],
        { platform: 'darwin' }
      );
      expect(pickedDotNet?.path).toBe('gamew.exe');

      const primaryFound = macNativeInstaller.findPrimaryExecutable(gogDotNetDir, {
        platform: 'darwin',
        preferWindowsExecutable: true,
      });
      expect(path.basename(String(primaryFound.executablePath || ''))).toBe('gamew.exe');

      const fakeHomeL4 = path.join(root, 'homeL4');
      const fakeUserDataL4 = path.join(root, 'userDataL4');
      const scanL4 = await installedScanner.scanAllInstalledGames({
        platform: 'darwin',
        homedir: fakeHomeL4,
        userDataDir: fakeUserDataL4,
        customRoots: [gogRoot],
        applicationsDirs: [],
        skipRegistry: true,
        forceRefresh: true,
      });
      const scannedDotNet = scanL4.installedGames.find((g) => String(g.platformGameId) === '123456');
      expect(scannedDotNet).toBeDefined();
      expect(path.basename(String(scannedDotNet?.executablePath || ''))).toBe('gamew.exe');

      // Supervisor self-heals cached `executablePath: GameLauncher.exe` (with NO `GOGLauncher.exe`) -> `gamew.exe`
      const appsDirL4 = path.join(root, 'AppsL4');
      const wineBinL4 = path.join(
        appsDirL4,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin',
        'wine'
      );
      fs.mkdirSync(path.dirname(wineBinL4), { recursive: true });
      fs.writeFileSync(wineBinL4, '#!/usr/bin/perl\nexit 0;\n', { mode: 0o755 });
      const bottleL4 = path.join(
        fakeHomeL4,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'BottleL4'
      );
      createSyntheticBottleTree(bottleL4);
      const l4SpawnArgs: string[][] = [];
      const launchL4 = await supervisor.launchGame(
        {
          gameId: 'gog-123456-dotnet-heal',
          title: 'Classic DotNet Game',
          platformId: 'gog',
          platformGameId: '123456',
          installPath: gogDotNetDir,
          executablePath: dotNetLauncherExe,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            wineBottleName: 'BottleL4',
            winePrefixPath: bottleL4,
            displayScalingMode: 'off',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: fakeHomeL4,
          userDataDir: fakeUserDataL4,
          customApplicationsDir: appsDirL4,
          skipRegistrySpawn: true,
          gameSpawnFn: (_cmd: string, args: string[]) => {
            l4SpawnArgs.push([...args]);
            return createFakeChildProcess(62401);
          },
        }
      );
      expect(launchL4.success).toBe(true);
      expect(l4SpawnArgs.some((argv) => argv.some((a) => a.toLowerCase().endsWith('gamew.exe')))).toBe(true);
      expect(l4SpawnArgs.some((argv) => argv.some((a) => a.toLowerCase().endsWith('gamelauncher.exe')))).toBe(false);
      await supervisor.finalizeGameSession('gog-123456-dotnet-heal', {
        platform: 'darwin',
        userDataDir: fakeUserDataL4,
      });

      // Negative test: Native Win32 launcher (NO `mscoree.dll` and NO `GOGLauncher.exe`) MUST NOT be bypassed
      const gogNativeDir = path.join(root, 'GogNativeLauncher');
      fs.mkdirSync(gogNativeDir, { recursive: true });
      fs.writeFileSync(
        path.join(gogNativeDir, 'NativeConfigLauncher.exe'),
        buildExtendedSyntheticPeBuffer({ arch: 'x86', importedDlls: ['kernel32.dll', 'user32.dll'] })
      );
      fs.writeFileSync(
        path.join(gogNativeDir, 'nativegame.exe'),
        buildExtendedSyntheticPeBuffer({ arch: 'x86', importedDlls: ['kernel32.dll', 'd3d9.dll'] })
      );
      const nativeTasks = [
        { category: 'launcher', isPrimary: true, name: 'Config', path: 'NativeConfigLauncher.exe', type: 'FileTask' },
        { category: 'game', name: 'Play', path: 'nativegame.exe', type: 'FileTask' },
      ];
      const pickedNative = binaryInspectors.selectPreferredGogPlayTask(
        nativeTasks,
        [gogNativeDir],
        { platform: 'darwin' }
      );
      expect(pickedNative?.path).toBe('NativeConfigLauncher.exe');

      // 4. R2-3: `-opengl4` parity between `inspectPeCapabilities` / `resolveEffectiveGameExecutableCapabilities` and `shouldWrapBottleSessionWithDisplayLauncher`
      const glParityDir = path.join(root, 'GlParity64');
      fs.mkdirSync(glParityDir, { recursive: true });
      const glParityExe = path.join(glParityDir, 'UnityOrUeMulti64.exe');
      fs.writeFileSync(
        glParityExe,
        buildExtendedSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'd3d11.dll', 'opengl32.dll', 'unityplayer.dll'],
        })
      );
      const peDefault = binaryInspectors.inspectPeCapabilities(glParityExe, { launchArguments: '' });
      const peOpengl4 = binaryInspectors.inspectPeCapabilities(glParityExe, { launchArguments: '-opengl4' });
      expect(peDefault.importsLegacyD3dOrGl).toBe(false);
      expect(peOpengl4.importsLegacyD3dOrGl).toBe(true);
      const effDefault = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        glParityExe,
        glParityDir,
        { launchArguments: '' }
      );
      const effOpengl4 = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        glParityExe,
        glParityDir,
        { launchArguments: '-opengl4' }
      );
      expect(effDefault.usesOpenGl).toBe(false);
      expect(effOpengl4.usesOpenGl).toBe(true);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(effDefault, 'auto_fullscreen', '')
      ).toBe(false);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(effOpengl4, 'auto_fullscreen', '-opengl4')
      ).toBe(true);
    });
  });
});
