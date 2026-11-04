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
};

const supervisor = requireCjs('../electron/launcher/sessionAndProcessSupervisor.cjs') as {
  shouldWrapBottleSessionWithDisplayLauncher: (
    effectiveCaps: Record<string, unknown> | null | undefined,
    effectiveDisplayScalingMode: string
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
});
