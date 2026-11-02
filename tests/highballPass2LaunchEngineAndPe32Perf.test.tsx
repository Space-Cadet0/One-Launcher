/**
 * Wave 3A — Hermetic Dual-OS Launch Engine, Clean-Room & 32-Bit Bottled Performance QA Gate
 * (`highballPass2LaunchEngineAndPe32Perf.test.tsx`)
 *
 * Covers Pass-2 upgrades end-to-end across `darwin` (Apple Silicon + CrossOver/Wine) and
 * `win32` (Windows x64 Native) using 100% synthetic generic fixtures in `os.tmpdir()`:
 *   0. Hygiene, MIT Clean-Room Boundary & Offline Network Guard (`net.Socket`)
 *   1. F-COMPAT-01: Chained Publisher Bottled PE32/PE32+ Routing (`darwin` & `win32`)
 *   2. F-COMPAT-02 & Wave 1C Mission 1: Bottle Steam Proxy DLLs, Warm Daemon Contract Recycle & Clean Wake Env
 *   3. F-COMPAT-03: Hardened Runtime `doesWineLoaderAllowDyldInsert`, MoltenVK+MetalHUD Deadlock Guard,
 *      Opt-In Audio Preload & Hermetic C11 ASan/UBSan Real-Time Audio Timer Harness (`one_metal_preload.c`)
 *   4. F-COMPAT-04 & Wave 1A B1: Shared Bottle `cxbottle.conf`, Non-Destructive `RetinaMode`,
 *      and Reference-Checked `explorer.exe\X11 Driver` `EmulateModeset`
 *   5. F-COMPAT-05 & F-COMPAT-10: Coalesced Live `wineserver` `reg.exe import` Sync + `win32` GOG 64-Bit `HKLM\Software` Parity
 *   6. F-COMPAT-06 & Wave 1C: 32-Bit Bottled Performance (`DXVK_CONFIG_FILE`, 3-Tier VRAM Caps, `DXMT_CONFIG`,
 *      MetalFX Spatial Upscale, FPS Cap, CrossOver 26.3.0 DLSS Kernel Gate, Opt-In `forceLargeAddressAware`)
 *   7. F-COMPAT-07, F-COMPAT-08, F-COMPAT-09 & UI WCAG 2.2 AA (`GameLaunchConfigModal` + `launchConfigStore`)
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadLocalKeyedHmacConfig,
  scanContentForPiiViolations,
} from './helpers/piiHygieneGuard';
import { createDomain12DeepRenderer } from './helpers/xboxTestHarness';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import { CompatibilityLayerSectionBase } from '../src/components/Launcher/LaunchConfig/CompatibilityLayerSection';
import { launcherService } from '../src/services/launcher/launcherService';
import {
  getLaunchConfigFromStorage,
  persistLocalLaunchConfigsToStorage,
} from '../src/services/launcher/launchConfigStore';
import type { CanonicalGame } from '../src/contracts/game';
import type { CompatibilityLayerInfo, GameLaunchConfig } from '../src/contracts/launcher';

const requireCjs = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, '..');

const binaryInspectors = requireCjs(
  '../electron/launcher/binaryAndManifestInspectors.cjs'
) as {
  resolveEffectiveGameExecutableCapabilities: (
    exePath?: string,
    installDir?: string
  ) => Record<string, any>;
};

const macNativeInstaller = requireCjs(
  '../electron/launcher/macNativeInstallerAndCodesign.cjs'
) as {
  detectCompatibilityLayers: (options?: Record<string, unknown>) => Array<Record<string, any>>;
  doesWineLoaderAllowDyldInsert: (wineBinary: string | Record<string, unknown>) => boolean;
  doesWineLayerHaveMoltenVkHudDeadlock: (wineBinary: string | Record<string, unknown>) => boolean;
  detectCrossOverBackendLayerSupport: (
    layer: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => {
    supportsCxGraphicsBackendVersion: boolean;
    supportsNativeDlss: boolean;
    majorVersion: number;
    minorVersion: number;
    patchVersion: number;
  };
  applyCrossOverPerGameSettings: (
    bottleDir: string | Record<string, unknown>,
    exeNameOrCfg?: string | Record<string, unknown>,
    launchConfig?: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Record<string, string>;
  ensureCompatibilityLayerReady: (
    layer: Record<string, unknown>,
    launchConfig: Record<string, unknown>,
    env: Record<string, string | undefined>,
    options?: Record<string, unknown>
  ) => Promise<{
    ready: boolean;
    winePrefix: string | null;
    warning?: string;
    resolvedGraphicsBackend?: string;
    resolvedBackendPolicyId?: string;
    peCapabilities?: Record<string, any>;
  }>;
  resolveTargetBottleForFirstPartySync: (
    payload?: Record<string, unknown> | string | null,
    storefront?: string | Record<string, unknown> | null,
    options?: Record<string, unknown>
  ) => string | null;
};

const supervisor = requireCjs(
  '../electron/launcher/sessionAndProcessSupervisor.cjs'
) as {
  computeBottleGraphicsEnvContract: (envObj?: Record<string, unknown> | null) => string;
  getLiveBottleDaemonEnvContract: (bottlePath: string) => string | null;
  resetSupervisorStateForTests: () => void;
  discoverValidatedAppLocalProxyDllOverrides: (
    candidateDirs: string[],
    effectiveMachine?: string,
    options?: Record<string, unknown>
  ) => {
    hasOverrides: boolean;
    envOverrideSpec: string;
    appDefaultsMap: Record<string, string>;
  };
  launchGame: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, any>>;
  finalizeGameSession: (
    gameId: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, any> | undefined>;
  getRunningGames: () => Array<Record<string, any>>;
};

const chainedLaunchers = requireCjs(
  '../electron/launcher/chainedPublisherLaunchers.cjs'
) as {
  buildChainedLauncherLaunchSpec: (params: Record<string, unknown>) => {
    launcherExe: string;
    targetExecutablePath: string;
    args: string[];
    launchUri?: string;
    handoffMode: string;
    envOverrides?: Record<string, string>;
  };
};

const gogScriptInterpreter = requireCjs(
  '../electron/storefronts/gog/gogScriptInterpreter.cjs'
) as {
  executeGogGameScript: (
    installDir: string,
    options?: Record<string, unknown>
  ) => Promise<{
    executed: boolean;
    skippedCached: boolean;
    scriptsProcessed: number;
    registryKeysApplied: number;
    supportFilesStaged: number;
    iniEntriesApplied: number;
  }>;
};

const engineStateRegistry = requireCjs(
  '../electron/launcher/engineStateRegistry.cjs'
) as {
  pendingWineRegSyncByPrefix: Map<string, Promise<unknown>>;
  activeSessions: Map<string, Record<string, any>>;
  onSessionUpdated: (listener: (ev: Record<string, any>) => void) => () => void;
};

const environmentProvisioner = requireCjs(
  '../electron/launcher/environmentProvisioner.cjs'
) as {
  runEnvironmentSetupTasks: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, any>>;
};

const firstPartyRegistration = requireCjs(
  '../electron/launcher/firstPartyRegistration.cjs'
) as {
  upsertWineSystemRegKeysBatch: (
    bottlePath: string,
    sections: Array<{
      subKeyPath: string;
      entries: Array<[string, { type: string; value: string | number } | null]>;
    }>,
    options?: Record<string, unknown>
  ) => { updated: boolean };
};

// ----------------------------------------------------------------------------
// Synthetic Binary & Bottle Fixture Builders (100% Generic / Non-PII)
// ----------------------------------------------------------------------------

interface SyntheticPeSpec {
  arch: 'x86' | 'x64';
  largeAddressAware?: boolean;
  nxCompat?: boolean;
  dynamicBase?: boolean;
  isDll?: boolean;
  importedDlls?: string[];
}

function buildSyntheticPeBuffer(spec: SyntheticPeSpec): Buffer {
  const buf = Buffer.alloc(0x1000, 0);
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
  if (spec.largeAddressAware) characteristics |= 0x0020; // IMAGE_FILE_LARGE_ADDRESS_AWARE
  if (!isX64 && !spec.largeAddressAware) characteristics |= 0x0100; // IMAGE_FILE_32BIT_MACHINE
  if (spec.isDll) characteristics |= 0x2000; // IMAGE_FILE_DLL
  buf.writeUInt16LE(characteristics, peOffset + 22);

  const optOffset = peOffset + 24;
  buf.writeUInt16LE(isX64 ? 0x020b : 0x010b, optOffset); // PE32+ vs PE32
  const imageBase = 0x00400000;
  if (isX64) {
    buf.writeBigUInt64LE(0x0000000140000000n, optOffset + 24);
  } else {
    buf.writeUInt32LE(imageBase, optOffset + 28);
  }

  let dllChars = 0;
  if (spec.dynamicBase ?? true) dllChars |= 0x0040;
  if (spec.nxCompat ?? true) dllChars |= 0x0100; // IMAGE_DLLCHARACTERISTICS_NX_COMPAT
  buf.writeUInt16LE(dllChars, optOffset + 70);

  const numRvaOffset = optOffset + (isX64 ? 108 : 92);
  buf.writeUInt32LE(16, numRvaOffset);
  const dataDirOffset = optOffset + (isX64 ? 112 : 96);

  const secTableOffset = optOffset + optHeaderSize;
  buf.write('.rdata\0\0', secTableOffset, 'ascii');
  buf.writeUInt32LE(0x0e00, secTableOffset + 8); // VirtualSize
  buf.writeUInt32LE(0x1000, secTableOffset + 12); // VirtualAddress
  buf.writeUInt32LE(0x0e00, secTableOffset + 16); // SizeOfRawData
  buf.writeUInt32LE(0x0200, secTableOffset + 20); // PointerToRawData
  buf.writeUInt32LE(0x40000040, secTableOffset + 36);

  const rvaToFile = (rva: number): number => 0x0200 + (rva - 0x1000);
  let stringCursorRva = 0x1500;
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
    importedDlls.forEach((dllName, idx) => {
      const descRaw = rvaToFile(importDirRva + idx * 20);
      const nameRva = writeAsciiRva(dllName);
      buf.writeUInt32LE(0, descRaw + 0);
      buf.writeUInt32LE(nameRva, descRaw + 12);
      buf.writeUInt32LE(0, descRaw + 16);
    });
  }

  return buf;
}

interface SyntheticMachoSignatureSpec {
  hardenedRuntime: boolean;
  entitlementsXml?: string;
}

/**
 * Construct a minimal valid 64-bit Mach-O (`0xfeedfacf` LE) containing an `LC_CODE_SIGNATURE`
 * (`0x1d`) SuperBlob (`0xfade0cc0` BE) with a `CodeDirectory` (`0xfade0c02`) and optional
 * `CS_MAGIC_ENTITLEMENTS` (`0xfade7171`) blob so `doesWineLoaderAllowDyldInsert` exercises real
 * binary parsing without touching host `/Applications` bundles.
 */
function buildSyntheticSignedMachO64(spec: SyntheticMachoSignatureSpec): Buffer {
  const headerSize = 32; // mach_header_64
  const lcSize = 16; // linkedit_data_command (cmd, cmdsize, dataoff, datasize)
  const sigOffset = 64;

  const codeDirBlob = Buffer.alloc(44, 0);
  codeDirBlob.writeUInt32BE(0xfade0c02, 0); // CS_MAGIC_CODEDIRECTORY
  codeDirBlob.writeUInt32BE(codeDirBlob.length, 4); // length
  codeDirBlob.writeUInt32BE(0x00020400, 8); // version
  codeDirBlob.writeUInt32BE(spec.hardenedRuntime ? 0x00010000 : 0x00000002, 12); // CS_RUNTIME vs adhoc

  const blobs: Array<{ type: number; data: Buffer }> = [{ type: 0, data: codeDirBlob }];
  if (typeof spec.entitlementsXml === 'string') {
    const xmlBytes = Buffer.from(spec.entitlementsXml, 'utf8');
    const entBlob = Buffer.alloc(8 + xmlBytes.length, 0);
    entBlob.writeUInt32BE(0xfade7171, 0); // CS_MAGIC_ENTITLEMENTS
    entBlob.writeUInt32BE(entBlob.length, 4);
    xmlBytes.copy(entBlob, 8);
    blobs.push({ type: 5, data: entBlob });
  }

  const indexTableBytes = blobs.length * 8;
  const superHeaderBytes = 12 + indexTableBytes;
  const totalBlobBytes = blobs.reduce((acc, b) => acc + b.data.length, 0);
  const superSize = superHeaderBytes + totalBlobBytes;

  const superBlob = Buffer.alloc(superSize, 0);
  superBlob.writeUInt32BE(0xfade0cc0, 0); // CS_MAGIC_EMBEDDED_SIGNATURE
  superBlob.writeUInt32BE(superSize, 4);
  superBlob.writeUInt32BE(blobs.length, 8);

  let relOffset = superHeaderBytes;
  blobs.forEach((b, idx) => {
    superBlob.writeUInt32BE(b.type, 12 + idx * 8);
    superBlob.writeUInt32BE(relOffset, 12 + idx * 8 + 4);
    b.data.copy(superBlob, relOffset);
    relOffset += b.data.length;
  });

  const out = Buffer.alloc(sigOffset + superBlob.length, 0);
  out.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  out.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  out.writeUInt32LE(0, 8);
  out.writeUInt32LE(2, 12); // MH_EXECUTE
  out.writeUInt32LE(1, 16); // ncmds = 1
  out.writeUInt32LE(lcSize, 20); // sizeofcmds
  out.writeUInt32LE(0, 24);
  out.writeUInt32LE(0, 28);

  // Load command 0: LC_CODE_SIGNATURE (0x1d)
  out.writeUInt32LE(0x0000001d, headerSize + 0);
  out.writeUInt32LE(lcSize, headerSize + 4);
  out.writeUInt32LE(sigOffset, headerSize + 8);
  out.writeUInt32LE(superBlob.length, headerSize + 12);

  superBlob.copy(out, sigOffset);
  return out;
}

interface SyntheticCrossOverRunner {
  appsDir: string;
  homedir: string;
  appBundleDir: string;
  winePerlPath: string;
  wineloaderPath: string;
  wineserverPath: string;
  cxbottlePath: string;
  cxbottleLogPath: string;
  bottlesDir: string;
  layer: Record<string, any>;
}

function createSyntheticCrossOverRunner(
  rootDir: string,
  opts: {
    version?: string;
    hardenedWineloader?: boolean;
    allowDyldEntitlement?: boolean;
    includeMoltenVkDeadlockSymbol?: boolean;
  } = {}
): SyntheticCrossOverRunner {
  const version = opts.version || '26.3.0';
  const homedir = path.join(rootDir, 'Home');
  const appsDir = path.join(homedir, 'Applications');
  const appBundleDir = path.join(appsDir, 'CrossOver.app');
  const contentsDir = path.join(appBundleDir, 'Contents');
  const sharedCrossOverDir = path.join(contentsDir, 'SharedSupport', 'CrossOver');
  const binDir = path.join(sharedCrossOverDir, 'bin');
  const hostedAppDir = path.join(sharedCrossOverDir, 'CrossOver-Hosted Application');
  const libDir = path.join(sharedCrossOverDir, 'lib');
  const bottlesDir = path.join(homedir, 'Library', 'Application Support', 'CrossOver', 'Bottles');
  const cxbottleLogPath = path.join(rootDir, 'cxbottle-args.log');

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(hostedAppDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(bottlesDir, { recursive: true });

  fs.writeFileSync(
    path.join(contentsDir, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}.39610</string>
</dict></plist>\n`,
    'utf8'
  );

  const winePerlPath = path.join(binDir, 'wine');
  fs.writeFileSync(
    winePerlPath,
    '#!/usr/bin/perl\n# synthetic crossover perl wrapper (--wait-children --dll)\nexit 0;\n',
    {
      mode: 0o755,
    }
  );

  const wineserverPath = path.join(binDir, 'wineserver');
  fs.writeFileSync(wineserverPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const cxbottlePath = path.join(binDir, 'cxbottle');
  fs.writeFileSync(
    cxbottlePath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${cxbottleLogPath}"\nexit 0\n`,
    { mode: 0o755 }
  );

  const wineloaderPath = path.join(hostedAppDir, 'wineloader');
  const entitlementsXml = opts.allowDyldEntitlement
    ? '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-dyld-environment-variables</key><true/></dict></plist>'
    : '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>';
  fs.writeFileSync(
    wineloaderPath,
    buildSyntheticSignedMachO64({
      hardenedRuntime: opts.hardenedWineloader ?? true,
      entitlementsXml,
    }),
    { mode: 0o755 }
  );

  if (opts.includeMoltenVkDeadlockSymbol) {
    fs.writeFileSync(
      path.join(libDir, 'libMoltenVK.dylib'),
      Buffer.from('MVK_SYNTH\0_GLOBAL__sub_I_mvk_datatypes.mm\0', 'utf8')
    );
  }

  const layer = {
    id: 'crossover-synth',
    name: 'CrossOver',
    type: 'crossover',
    version,
    binaryPath: winePerlPath,
    wineserverPath,
    bottlesDir,
    availableBottles: [],
    supportsNativeDlss: true,
    supportsCxGraphicsBackendVersion: true,
    availableD3DMetalVersions: [{ id: 'default', label: 'Bundled (v3.0)', version: '3.0', isDefault: true }],
  };

  return {
    appsDir,
    homedir,
    appBundleDir,
    winePerlPath,
    wineloaderPath,
    wineserverPath,
    cxbottlePath,
    cxbottleLogPath,
    bottlesDir,
    layer,
  };
}

function createSyntheticBottle(
  bottlesDir: string,
  bottleName: string,
  extra: {
    cxbottleEnv?: Record<string, string>;
    userRegExtra?: string;
    systemRegExtra?: string;
  } = {}
): string {
  const bottleDir = path.join(bottlesDir, bottleName);
  fs.mkdirSync(path.join(bottleDir, 'drive_c', 'windows', 'system32'), { recursive: true });
  const envEntries = Object.entries(extra.cxbottleEnv || {})
    .map(([k, v]) => `"${k}" = "${v}"`)
    .join('\n');
  fs.writeFileSync(
    path.join(bottleDir, 'cxbottle.conf'),
    `[Bottle]\n"UpdaterVersion" = "260300"\n\n[EnvironmentVariables]\n${envEntries ? envEntries + '\n' : ''}`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(bottleDir, 'user.reg'),
    `WINE REGISTRY Version 2\n;; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000\n\n${extra.userRegExtra || ''}`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(bottleDir, 'system.reg'),
    `WINE REGISTRY Version 2\n;; All keys relative to \\\\Machine\n\n${extra.systemRegExtra || ''}`,
    'utf8'
  );
  return bottleDir;
}

class MockChildProcess extends EventEmitter {
  public pid: number;
  public stdout = new EventEmitter();
  public stderr: EventEmitter & { destroyed?: boolean; readable?: boolean };
  public killed = false;
  public unrefCalled = false;

  constructor(pid = 48120) {
    super();
    this.pid = pid;
    const errStream = new EventEmitter() as EventEmitter & {
      destroyed?: boolean;
      readable?: boolean;
    };
    errStream.destroyed = false;
    errStream.readable = false;
    this.stderr = errStream;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  unref(): void {
    this.unrefCalled = true;
  }
}

function walkRepoFiles(dir: string, extRe: RegExp, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'release' ||
      entry.name.startsWith('.')
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRepoFiles(full, extRe, out);
    } else if (entry.isFile() && extRe.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
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
        !/\b(min-h-(?:[6-9]|\d{2,})|h-(?:[6-9]|\d{2,})|p-(?:[2-9]|\d{2,})|py-(?:[2-9]|1\.5|\d{2,})|underline)\b/.test(
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

// ----------------------------------------------------------------------------
// Suite Lifecycle
// ----------------------------------------------------------------------------

describe('Wave 3A — Pass-2 Dual-OS Launch Engine, Clean-Room & 32-Bit Bottled Performance QA Gate', () => {
  let suiteTmpRoot = '';
  let testTmpDir = '';
  let testSeq = 0;

  beforeAll(() => {
    suiteTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-pass2-qa-'));
  });

  beforeEach(() => {
    testSeq += 1;
    testTmpDir = path.join(suiteTmpRoot, `case-${testSeq}`);
    fs.mkdirSync(testTmpDir, { recursive: true });
    supervisor.resetSupervisorStateForTests();
    engineStateRegistry.pendingWineRegSyncByPrefix.clear();
  });

  afterEach(async () => {
    for (const activeGameId of Array.from(engineStateRegistry.activeSessions.keys())) {
      try {
        await supervisor.finalizeGameSession(activeGameId, {
          skipPostSessionCloudSync: true,
        });
      } catch {
        // ignore cleanup errors
      }
    }
    supervisor.resetSupervisorStateForTests();
    engineStateRegistry.pendingWineRegSyncByPrefix.clear();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (suiteTmpRoot && fs.existsSync(suiteTmpRoot)) {
      fs.rmSync(suiteTmpRoot, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 0. Hygiene, MIT Clean-Room Boundary & Offline Network Guard
  // --------------------------------------------------------------------------
  describe('0. Hygiene, MIT Clean-Room Boundary & Offline Network Guard', () => {
    it('verifies zero PII violations in this test file, MIT clean-room compliance, and active offline net.Socket guard', async () => {
      const hmacCfg = loadLocalKeyedHmacConfig(REPO_ROOT);
      const selfPath = path.join(REPO_ROOT, 'tests', 'highballPass2LaunchEngineAndPe32Perf.test.tsx');
      const selfText = fs.readFileSync(selfPath, 'utf8');
      expect(
        scanContentForPiiViolations(
          selfText,
          'tests/highballPass2LaunchEngineAndPe32Perf.test.tsx',
          hmacCfg
        )
      ).toEqual([]);

      // Self-check that zero literal macOS personal home prefixes or real storefront AppIDs appear in this file
      const literalPersonalPrefix = ['/', 'Users', '/'].join('');
      expect(selfText.includes(literalPersonalPrefix)).toBe(false);

      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
      expect(pkg.license).toBe('MIT');

      const bannedRefRepoPattern = new RegExp(`\\b${['high', 'ball'].join('')}\\b`, 'i');
      const gplHeaderPattern = new RegExp(
        [
          ['GNU', 'General', 'Public', 'License'].join('\\s+'),
          'SPDX-License-Identifier:\\s*(?:A|L)?GPL',
        ].join('|'),
        'i'
      );
      expect(bannedRefRepoPattern.test(selfText)).toBe(false);

      const sourceFiles = [
        ...walkRepoFiles(path.join(REPO_ROOT, 'src'), /\.(?:ts|tsx)$/i),
        ...walkRepoFiles(path.join(REPO_ROOT, 'electron'), /\.(?:cjs|mjs|js|c|h)$/i),
      ];
      const violations: string[] = [];
      for (const file of sourceFiles) {
        const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
        const content = fs.readFileSync(file, 'utf8');
        if (gplHeaderPattern.test(content)) {
          violations.push(`${rel}: copyleft GPL header`);
        }
        if (bannedRefRepoPattern.test(content)) {
          violations.push(`${rel}: external reference repo identifier`);
        }
      }
      expect(violations).toEqual([]);

      // Verify offlineNetworkGuard.ts blocks outbound public TCP sockets
      await expect(
        new Promise<void>((resolve, reject) => {
          const sock = new net.Socket();
          sock.once('error', (err) => {
            sock.destroy();
            reject(err);
          });
          sock.connect(443, '93.184.216.34', () => {
            sock.destroy();
            resolve();
          });
        })
      ).rejects.toThrow(/OfflineNetworkGuard|Blocked unmocked outbound network request/i);
    });
  });

  // --------------------------------------------------------------------------
  // 1. F-COMPAT-01: Chained Publisher Bottled PE32/PE32+ Routing (darwin & win32)
  // --------------------------------------------------------------------------
  describe('1. F-COMPAT-01: Chained Publisher Bottled PE32/PE32+ Routing (darwin & win32)', () => {
    it('populates targetExecutablePath in buildChainedLauncherLaunchSpec and inspects bottle <game.exe> BEFORE ensureCompatibilityLayerReady on darwin while preserving win32 native chained launches', async () => {
      const runner = createSyntheticCrossOverRunner(path.join(testTmpDir, 'cx-chained'));
      const bottleName = 'SynthPublisherBottle';
      const bottleDir = createSyntheticBottle(runner.bottlesDir, bottleName, {
        systemRegExtra: [
          '[Software\\\\Wow6432Node\\\\Ubisoft\\\\Launcher\\\\Installs\\\\9901]',
          '"InstallDir"="C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Synthetic Publisher Action 32/"',
          '',
        ].join('\n'),
      });
      runner.layer.availableBottles = [bottleName];

      // Create 64-bit publisher client (upc.exe + EADesktop.exe) AND 32-bit non-LAA non-NX DX11 game.exe
      const upcDir = path.join(bottleDir, 'drive_c', 'Program Files (x86)', 'Ubisoft', 'Ubisoft Game Launcher');
      const gameDir = path.join(upcDir, 'games', 'Synthetic Publisher Action 32');
      fs.mkdirSync(gameDir, { recursive: true });
      const upcExe = path.join(upcDir, 'upc.exe');
      fs.writeFileSync(
        upcExe,
        buildSyntheticPeBuffer({
          arch: 'x64',
          largeAddressAware: true,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'd3d12.dll'],
        })
      );
      const gameExe = path.join(gameDir, 'SynthAction32.exe');
      fs.writeFileSync(
        gameExe,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: false,
          nxCompat: false, // non-DEP 32-bit -> must guard against DXMT and route to DXVK + 1536 MiB cap
          importedDlls: ['KERNEL32.dll', 'd3d11.dll', 'dxgi.dll'],
        })
      );
      // Valid 32-bit version.dll proxy next to game.exe + mismatched 64-bit dinput8.dll (must be rejected)
      fs.writeFileSync(
        path.join(gameDir, 'version.dll'),
        buildSyntheticPeBuffer({ arch: 'x86', isDll: true, importedDlls: ['KERNEL32.dll'] })
      );
      fs.writeFileSync(
        path.join(gameDir, 'dinput8.dll'),
        buildSyntheticPeBuffer({ arch: 'x64', isDll: true, importedDlls: ['KERNEL32.dll'] })
      );

      // 1a. Verify buildChainedLauncherLaunchSpec sets targetExecutablePath across publisher ecosystems
      const ubiSpec = chainedLaunchers.buildChainedLauncherLaunchSpec({
        handoffId: 'ubisoft',
        externalInstallId: '9901',
        launcherBinaryPath: upcExe,
        gameExecutablePath: gameExe,
        installDir: gameDir,
        bottlePath: bottleDir,
        platform: 'darwin',
        compatibilityLayerType: 'crossover',
      });
      expect(ubiSpec.launcherExe).toBe(upcExe);
      expect(ubiSpec.targetExecutablePath).toBe(gameExe);
      expect(ubiSpec.args).toContain('uplay://launch/9901/0');

      const eaDir = path.join(bottleDir, 'drive_c', 'Program Files', 'Electronic Arts', 'EA Desktop', 'EA Desktop');
      fs.mkdirSync(eaDir, { recursive: true });
      const eaDesktopExe = path.join(eaDir, 'EADesktop.exe');
      fs.writeFileSync(eaDesktopExe, buildSyntheticPeBuffer({ arch: 'x64', importedDlls: ['KERNEL32.dll'] }));
      const eaSpec = chainedLaunchers.buildChainedLauncherLaunchSpec({
        handoffId: 'ea',
        externalInstallId: 'Origin.OFR.50.9990001',
        launcherBinaryPath: eaDesktopExe,
        gameExecutablePath: gameExe,
        installDir: gameDir,
        bottlePath: bottleDir,
        platform: 'darwin',
        compatibilityLayerType: 'crossover',
      });
      expect(eaSpec.launcherExe).toBe(eaDesktopExe);
      expect(eaSpec.targetExecutablePath).toBe(gameExe);

      // 1b. Launch chained Ubisoft game on darwin WITHOUT passing executablePath up-front:
      // launchChainedPublisherGame must discover SynthAction32.exe in the bottle BEFORE ensureCompatibilityLayerReady!
      const darwinSpawns: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> = [];
      const userDataDir = path.join(testTmpDir, 'userdata-chained-mac');
      fs.mkdirSync(userDataDir, { recursive: true });

      const darwinRes = await supervisor.launchGame(
        {
          gameId: 'ubisoft:syn-ubisoft-32',
          title: 'Synthetic Publisher Action 32',
          platformId: 'ubisoft',
          platformGameId: 'syn-ubisoft-32',
          chainedLauncherHandoff: 'ubisoft',
          chainedExternalInstallId: '9901',
          installPath: gameDir, // bottle install path, no executablePath passed in payload
          launchConfig: {
            compatibilityLayer: 'crossover',
            wineBottleName: bottleName,
            winePrefixPath: bottleDir,
            crossoverGraphicsBackend: 'auto',
          },
        },
        {
          platform: 'darwin',
          homedir: runner.homedir,
          customApplicationsDir: runner.appsDir,
          userDataDir,
          layers: [runner.layer],
          skipPublisherProvisioning: true,
          disableChainedLauncherPolling: true,
          skipRegistrySpawn: true,
          gameSpawnFn: (cmd: string, args: string[], spawnOpts: { env: Record<string, string | undefined> }) => {
            darwinSpawns.push({ cmd, args, env: { ...spawnOpts.env } });
            return new MockChildProcess(51001);
          },
        }
      );

      expect(darwinRes.success).toBe(true);
      expect(darwinSpawns).toHaveLength(1);
      const chainedSpawn = darwinSpawns[0];
      expect(chainedSpawn.cmd).toBe(runner.winePerlPath);
      // Spawns upc.exe with uplay://launch/9901/0 + validated x86 version=n,b override, yet graphics routing used SynthAction32.exe (PE32 non-NX -> dxvk)!
      expect(chainedSpawn.args).toContain(upcExe);
      expect(chainedSpawn.args).toContain('uplay://launch/9901/0');
      expect(String(chainedSpawn.env.WINEDLLOVERRIDES || '')).toContain('version=n,b');
      expect(String(chainedSpawn.env.WINEDLLOVERRIDES || '')).not.toContain('dinput8');
      expect(chainedSpawn.env.CX_GRAPHICS_BACKEND).toBe('dxvk');
      expect(chainedSpawn.env.DXVK_CONFIG_FILE).toBeTruthy();

      const dxvkConfContent = fs.readFileSync(String(chainedSpawn.env.DXVK_CONFIG_FILE), 'utf8');
      expect(dxvkConfContent).toContain('d3d9.maxAvailableMemory = 1536');
      expect(dxvkConfContent).toContain('dxgi.maxDeviceMemory = 1536');

      const userReg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(userReg).toContain('"VideoMemorySize"="1536"');
      expect(userReg).toContain('[Software\\\\Wine\\\\AppDefaults\\\\synthaction32.exe\\\\DllOverrides]');
      expect(userReg).toContain('"version"="native,builtin"');
      expect(userReg).not.toContain('"dinput8"="native,builtin"');

      await supervisor.finalizeGameSession('ubisoft:syn-ubisoft-32', {
        skipPostSessionCloudSync: true,
      });

      // 1b-warm (D2): Warm upc.exe booted under dxvk MUST recycle when launching a 64-bit PE32+ D3D12 game ('auto' -> d3dmetal)
      const game64Dir = path.join(bottleDir, 'drive_c', 'Games', 'Synthetic Publisher DX12 64');
      const game64Exe = path.join(game64Dir, 'SynthDx12_64.exe');
      fs.mkdirSync(game64Dir, { recursive: true });
      fs.writeFileSync(
        game64Exe,
        buildSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['KERNEL32.dll', 'd3d12.dll', 'dxgi.dll'],
        })
      );

      let warmWineserverRecycleCount = 0;
      const warmPublisherRes = await supervisor.launchGame(
        {
          gameId: 'ubisoft:syn-ubisoft-64',
          title: 'Synthetic Publisher DX12 64',
          platformId: 'ubisoft',
          platformGameId: 'syn-ubisoft-64',
          chainedLauncherHandoff: 'ubisoft',
          chainedExternalInstallId: '9902',
          installPath: game64Dir,
          launchConfig: {
            compatibilityLayer: 'crossover',
            wineBottleName: bottleName,
            winePrefixPath: bottleDir,
            crossoverGraphicsBackend: 'auto',
          },
        },
        {
          platform: 'darwin',
          homedir: runner.homedir,
          customApplicationsDir: runner.appsDir,
          userDataDir,
          layers: [runner.layer],
          skipPublisherProvisioning: true,
          disableChainedLauncherPolling: true,
          skipRegistrySpawn: true,
          enableWarmDaemonEnvRecycle: true,
          mockProcessListOutput: '51001 C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe\n',
          execFileFn: (
            bin: string,
            args: string[],
            _opts: unknown,
            cb?: (err: Error | null, stdout: string, stderr: string) => void
          ) => {
            if (/wineserver/i.test(bin) && args.includes('-k')) {
              warmWineserverRecycleCount += 1;
            }
            if (typeof cb === 'function') cb(null, '', '');
          },
          gameSpawnFn: (cmd: string, args: string[], spawnOpts: { env: Record<string, string | undefined> }) => {
            darwinSpawns.push({ cmd, args, env: { ...spawnOpts.env } });
            return new MockChildProcess(51002);
          },
        }
      );
      expect(warmPublisherRes.success).toBe(true);
      expect(warmWineserverRecycleCount).toBeGreaterThanOrEqual(1);
      const updatedPublisherContract = JSON.parse(
        String(supervisor.getLiveBottleDaemonEnvContract(bottleDir))
      );
      expect(updatedPublisherContract.backend).toBe('auto');
      await supervisor.finalizeGameSession('ubisoft:syn-ubisoft-64', {
        skipPostSessionCloudSync: true,
      });

      // 1c. Verify win32 native chained publisher launch runs directly with zero Wine calls
      const winHostDir = path.join(testTmpDir, 'win32-host');
      const winUpcExe = path.join(winHostDir, 'Ubisoft Game Launcher', 'upc.exe');
      const winGameDir = path.join(winHostDir, 'Games', 'Synthetic Publisher Action 32');
      const winGameExe = path.join(winGameDir, 'SynthAction32.exe');
      fs.mkdirSync(path.dirname(winUpcExe), { recursive: true });
      fs.mkdirSync(winGameDir, { recursive: true });
      fs.writeFileSync(winUpcExe, buildSyntheticPeBuffer({ arch: 'x64', importedDlls: ['KERNEL32.dll'] }));
      fs.writeFileSync(winGameExe, buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll'] }));

      const winSpawns: Array<{ cmd: string; args: string[] }> = [];
      const winExecCalls: string[] = [];
      const winRes = await supervisor.launchGame(
        {
          gameId: 'ubisoft:syn-ubisoft-win32',
          title: 'Synthetic Publisher Action 32',
          platformId: 'ubisoft',
          platformGameId: 'syn-ubisoft-win32',
          chainedLauncherHandoff: 'ubisoft',
          chainedExternalInstallId: '9901',
          installPath: winGameDir,
          executablePath: winGameExe,
        },
        {
          platform: 'win32',
          homedir: path.join(testTmpDir, 'home-win32'),
          userDataDir: path.join(testTmpDir, 'userdata-win32'),
          disableChainedLauncherPolling: true,
          ensureChainedPublisherLauncherInstalledFn: async () => ({
            installed: true,
            binaryPath: winUpcExe,
            hasLocalSession: true,
          }),
          execFileFn: (bin: string, _args: string[], _opts: unknown, cb?: (err: Error | null, out: string) => void) => {
            winExecCalls.push(bin);
            if (typeof cb === 'function') cb(null, '');
          },
          gameSpawnFn: (cmd: string, args: string[]) => {
            winSpawns.push({ cmd, args });
            return new MockChildProcess(62001);
          },
        }
      );

      expect(winRes.success).toBe(true);
      expect(winSpawns).toHaveLength(1);
      expect(winSpawns[0].cmd).toBe(winUpcExe);
      expect(winSpawns[0].args).toEqual(['uplay://launch/9901/0']);
      expect(winExecCalls.some((c) => /wine/i.test(c))).toBe(false);

      await supervisor.finalizeGameSession('ubisoft:syn-ubisoft-win32', {
        skipPostSessionCloudSync: true,
      });
    });
  });

  // --------------------------------------------------------------------------
  // 2. F-COMPAT-02 & Wave 1C Mission 1: Bottle Steam Proxy DLLs, Warm Daemon Recycle & Clean Wake Env
  // --------------------------------------------------------------------------
  describe('2. F-COMPAT-02 & Wave 1C Mission 1: Bottle Steam Proxy DLLs, Warm Daemon Contract Recycle & Clean Wake Env', () => {
    it('discovers app-local proxy DLLs for Bottle Steam, recycles warm Steam.exe only on graphics contract mismatch, and strips HUD/32-bit backend vars from GOG/Epic wake env', async () => {
      const runner = createSyntheticCrossOverRunner(path.join(testTmpDir, 'cx-steam'));
      const bottleName = 'SynthSteamBottle';
      const bottleDir = createSyntheticBottle(runner.bottlesDir, bottleName);
      runner.layer.availableBottles = [bottleName];

      // Create bottle Steam.exe + two synthetic games inside steamapps/common:
      //  - Game A: 64-bit PE32+ DX11 ('auto' -> backend=auto)
      //  - Game B: 32-bit PE32 DEP DX11 + validated x86 version.dll ('auto' -> backend=dxmt)
      const steamDir = path.join(bottleDir, 'drive_c', 'Program Files (x86)', 'Steam');
      const steamExe = path.join(steamDir, 'Steam.exe');
      const game64Dir = path.join(steamDir, 'steamapps', 'common', 'Synthetic Studio RPG 64');
      const game32Dir = path.join(steamDir, 'steamapps', 'common', 'Synthetic Retro Action 32');
      fs.mkdirSync(game64Dir, { recursive: true });
      fs.mkdirSync(game32Dir, { recursive: true });

      fs.writeFileSync(steamExe, buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll'] }));
      const game64Exe = path.join(game64Dir, 'SynthStudio64.exe');
      fs.writeFileSync(
        game64Exe,
        buildSyntheticPeBuffer({
          arch: 'x64',
          largeAddressAware: true,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'd3d11.dll', 'dxgi.dll'],
        })
      );
      const game32Exe = path.join(game32Dir, 'SynthSteam32.exe');
      fs.writeFileSync(
        game32Exe,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: true,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'd3d11.dll', 'dxgi.dll'],
        })
      );
      fs.writeFileSync(
        path.join(game32Dir, 'version.dll'),
        buildSyntheticPeBuffer({ arch: 'x86', isDll: true, importedDlls: ['KERNEL32.dll'] })
      );

      const userDataDir = path.join(testTmpDir, 'userdata-steam');
      fs.mkdirSync(userDataDir, { recursive: true });

      let mockSteamRunningInPs = false;
      const execCalls: Array<{ bin: string; args: string[] }> = [];
      const steamSpawns: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> = [];

      const commonOpts = {
        platform: 'darwin',
        homedir: runner.homedir,
        customApplicationsDir: runner.appsDir,
        userDataDir,
        layers: [runner.layer],
        allowBottleClientWakeInTest: true,
        disableBottleSteamPolling: true,
        enableWarmDaemonEnvRecycle: true,
        skipRegistrySpawn: true,
        execFileFn: (
          bin: string,
          args: string[],
          _opts: unknown,
          cb?: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          execCalls.push({ bin, args: [...(args || [])] });
          if (bin === 'ps') {
            const out = mockSteamRunningInPs
              ? 'C:\\Program Files (x86)\\Steam\\Steam.exe -silent\n'
              : '';
            if (cb) cb(null, out, '');
            return;
          }
          if (cb) cb(null, '', '');
        },
        gameSpawnFn: (cmd: string, args: string[], spawnOpts: { env: Record<string, string | undefined> }) => {
          steamSpawns.push({ cmd, args: [...args], env: { ...spawnOpts.env } });
          return new MockChildProcess(52000 + steamSpawns.length);
        },
      };

      // Launch 1: Cold bottle Steam launch of 64-bit DX11 game ('auto' -> backend=auto)
      const res1 = await supervisor.launchGame(
        {
          gameId: 'steam:990001',
          title: 'Synthetic Studio RPG 64',
          platformId: 'steam',
          platformGameId: '990001',
          steamAppId: '990001',
          installPath: game64Dir,
          executablePath: game64Exe,
          launchConfig: {
            compatibilityLayer: 'crossover',
            wineBottleName: bottleName,
            winePrefixPath: bottleDir,
            crossoverGraphicsBackend: 'auto',
            storefrontClientLifecycle: 'keep_running',
            autoShutdownWineAfterExit: false,
          },
        },
        commonOpts
      );
      expect(res1.success).toBe(true);
      expect(JSON.parse(String(supervisor.getLiveBottleDaemonEnvContract(bottleDir)))).toMatchObject({
        backend: 'auto',
      });
      await supervisor.finalizeGameSession('steam:990001', { skipPostSessionCloudSync: true });

      // Launch 2: Warm Steam.exe running + SAME 64-bit 'auto' contract -> MUST NOT run Steam.exe -shutdown!
      mockSteamRunningInPs = true;
      execCalls.length = 0;
      const res2 = await supervisor.launchGame(
        {
          gameId: 'steam:990001',
          title: 'Synthetic Studio RPG 64',
          platformId: 'steam',
          platformGameId: '990001',
          steamAppId: '990001',
          installPath: game64Dir,
          executablePath: game64Exe,
          launchConfig: {
            compatibilityLayer: 'crossover',
            wineBottleName: bottleName,
            winePrefixPath: bottleDir,
            crossoverGraphicsBackend: 'auto',
            storefrontClientLifecycle: 'keep_running',
            autoShutdownWineAfterExit: false,
          },
        },
        commonOpts
      );
      expect(res2.success).toBe(true);
      expect(execCalls.some((c) => c.args.includes('-shutdown'))).toBe(false);
      await supervisor.finalizeGameSession('steam:990001', { skipPostSessionCloudSync: true });

      // Launch 3: Warm Steam.exe running (booted under 'auto') + 32-bit PE32 DEP DX11 game ('auto' -> 'dxmt')
      // MUST detect contract mismatch, recycle warm Steam.exe (-shutdown), record backend=dxmt, and pass --dll version=n,b!
      execCalls.length = 0;
      const res3 = await supervisor.launchGame(
        {
          gameId: 'steam:990002',
          title: 'Synthetic Retro Action 32',
          platformId: 'steam',
          platformGameId: '990002',
          steamAppId: '990002',
          installPath: game32Dir,
          executablePath: game32Exe,
          launchConfig: {
            compatibilityLayer: 'crossover',
            wineBottleName: bottleName,
            winePrefixPath: bottleDir,
            crossoverGraphicsBackend: 'auto',
            storefrontClientLifecycle: 'keep_running',
            autoShutdownWineAfterExit: false,
          },
        },
        commonOpts
      );
      expect(res3.success).toBe(true);
      expect(execCalls.some((c) => c.args.includes('-shutdown'))).toBe(true);
      expect(JSON.parse(String(supervisor.getLiveBottleDaemonEnvContract(bottleDir)))).toMatchObject({
        backend: 'dxmt',
      });

      const launch3Spawn = steamSpawns[steamSpawns.length - 1];
      expect(launch3Spawn.env.CX_GRAPHICS_BACKEND).toBe('dxmt');
      expect(launch3Spawn.args[0]).toBe('--dll');
      expect(launch3Spawn.args[1]).toContain('version=n,b');
      expect(launch3Spawn.args.some((a) => /steam\.exe$/i.test(a))).toBe(true);
      expect(launch3Spawn.args).toContain('-applaunch');
      expect(launch3Spawn.args).toContain('990002');

      const steamBottleUserReg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(steamBottleUserReg).toContain(
        '[Software\\\\Wine\\\\AppDefaults\\\\synthsteam32.exe\\\\DllOverrides]'
      );
      expect(steamBottleUserReg).toContain('"version"="native,builtin"');
      await supervisor.finalizeGameSession('steam:990002', { skipPostSessionCloudSync: true });

      // 2b. Clean Background Wake Env: Bottled GOG GalaxyClient.exe wake strips HUD & auto-routed 32-bit CX_GRAPHICS_BACKEND
      const gogExeDir = path.join(bottleDir, 'drive_c', 'Program Files (x86)', 'GOG Galaxy');
      const gogClientExe = path.join(gogExeDir, 'GalaxyClient.exe');
      const gogGameDir = path.join(bottleDir, 'drive_c', 'GOG Games', 'Synthetic Galaxy Quest 32');
      const gogGameExe = path.join(gogGameDir, 'SynthGalaxy32.exe');
      fs.mkdirSync(gogExeDir, { recursive: true });
      fs.mkdirSync(gogGameDir, { recursive: true });
      fs.writeFileSync(gogClientExe, buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll'] }));
      fs.writeFileSync(
        gogGameExe,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: true,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'd3d11.dll', 'dxgi.dll'],
        })
      );

      const bgWakeSpawns: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const fgGameSpawns: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];

      const gogRes = await supervisor.launchGame(
        {
          gameId: 'gog:19990001',
          title: 'Synthetic Galaxy Quest 32',
          platformId: 'gog',
          platformGameId: '19990001',
          installPath: gogGameDir,
          executablePath: gogGameExe,
          launchConfig: {
            compatibilityLayer: 'crossover',
            wineBottleName: bottleName,
            winePrefixPath: bottleDir,
            crossoverGraphicsBackend: 'auto', // auto-routes 32-bit DX11 -> dxmt for game, NOT for GalaxyClient.exe
            metalHud: true,
            dxvkHud: true,
            storefrontClientLifecycle: 'minimal_stop_after_exit',
          },
        },
        {
          platform: 'darwin',
          homedir: runner.homedir,
          customApplicationsDir: runner.appsDir,
          userDataDir,
          layers: [runner.layer],
          allowBottleClientWakeInTest: true,
          skipRegistrySpawn: true,
          execFileFn: (_b: string, _a: string[], _o: unknown, cb?: (e: Error | null, out: string) => void) => {
            if (cb) cb(null, '');
          },
          bottleClientSpawnFn: (_cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
            bgWakeSpawns.push({ args: [...args], env: { ...opts.env } });
            return new MockChildProcess(53001);
          },
          gameSpawnFn: (_cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
            fgGameSpawns.push({ args: [...args], env: { ...opts.env } });
            return new MockChildProcess(53002);
          },
        }
      );

      expect(gogRes.success).toBe(true);
      expect(bgWakeSpawns).toHaveLength(1);
      expect(fgGameSpawns).toHaveLength(1);
      expect(bgWakeSpawns[0].args.some((a) => /galaxyclient\.exe$/i.test(a))).toBe(true);
      expect(bgWakeSpawns[0].env.MTL_HUD_ENABLED).toBeUndefined();
      expect(bgWakeSpawns[0].env.DXVK_HUD).toBeUndefined();
      expect(bgWakeSpawns[0].env.CX_GRAPHICS_BACKEND).toBeUndefined();
      expect(String(bgWakeSpawns[0].env.CX_ENV || '')).not.toContain('MTL_HUD_ENABLED');
      expect(String(bgWakeSpawns[0].env.CX_ENV || '')).not.toContain('DXVK_HUD');

      // Foreground <game.exe> retains its full 32-bit DXMT routing and HUD flags
      expect(fgGameSpawns[0].args.some((a) => /synthgalaxy32\.exe$/i.test(a))).toBe(true);
      expect(fgGameSpawns[0].env.CX_GRAPHICS_BACKEND).toBe('dxmt');
      expect(fgGameSpawns[0].env.MTL_HUD_ENABLED).toBe('1');
      expect(fgGameSpawns[0].env.DXVK_HUD).toBe('devinfo,fps,frametimes');

      await supervisor.finalizeGameSession('gog:19990001', { skipPostSessionCloudSync: true });
    });
  });

  // --------------------------------------------------------------------------
  // 3. F-COMPAT-03: Hardened Runtime Preload Gate, Deadlock Guard, Opt-In Audio & C11 ASan/UBSan
  // --------------------------------------------------------------------------
  describe('3. F-COMPAT-03: Hardened Runtime doesWineLoaderAllowDyldInsert, Deadlock Guard, Opt-In Audio Preload & C11 Real-Time Audio Timer', () => {
    it('parses Mach-O LC_CODE_SIGNATURE Hardened Runtime & entitlements, guards MoltenVK+MetalHUD deadlock when preload is stripped, and keeps audio preload opt-in', async () => {
      // 3a. Hardened Runtime WITHOUT allow-dyld-environment-variables -> false (both direct & via Perl wrapper)
      const hardenedRunner = createSyntheticCrossOverRunner(path.join(testTmpDir, 'cx-hardened'), {
        hardenedWineloader: true,
        allowDyldEntitlement: false,
        includeMoltenVkDeadlockSymbol: true,
      });
      expect(macNativeInstaller.doesWineLoaderAllowDyldInsert(hardenedRunner.wineloaderPath)).toBe(
        false
      );
      expect(macNativeInstaller.doesWineLoaderAllowDyldInsert(hardenedRunner.winePerlPath)).toBe(
        false
      );
      expect(
        macNativeInstaller.doesWineLayerHaveMoltenVkHudDeadlock(hardenedRunner.winePerlPath)
      ).toBe(true);

      // 3b. Hardened Runtime WITH com.apple.security.cs.allow-dyld-environment-variables -> true
      const entitledRunner = createSyntheticCrossOverRunner(path.join(testTmpDir, 'cx-entitled'), {
        hardenedWineloader: true,
        allowDyldEntitlement: true,
        includeMoltenVkDeadlockSymbol: false,
      });
      expect(macNativeInstaller.doesWineLoaderAllowDyldInsert(entitledRunner.wineloaderPath)).toBe(
        true
      );
      expect(macNativeInstaller.doesWineLoaderAllowDyldInsert(entitledRunner.winePerlPath)).toBe(
        true
      );

      // 3c. Non-hardened ad-hoc Mach-O -> true
      const adhocBin = path.join(testTmpDir, 'wine64-adhoc');
      fs.writeFileSync(
        adhocBin,
        buildSyntheticSignedMachO64({ hardenedRuntime: false }),
        { mode: 0o755 }
      );
      expect(macNativeInstaller.doesWineLoaderAllowDyldInsert(adhocBin)).toBe(true);

      // Optional host check: if /Applications/CrossOver.app exists on this Mac, verify real CrossOver wineloader -> false
      const hostCxWine = '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
      if (fs.existsSync(hostCxWine)) {
        expect(macNativeInstaller.doesWineLoaderAllowDyldInsert(hostCxWine)).toBe(false);
      }

      // 3d. MoltenVK + Metal HUD deadlock guard on Hardened Runtime runner:
      //  - Case A (metalHud: true): ensureCompatibilityLayerReady suppresses MTL_HUD_ENABLED=1 & DYLD_INSERT_LIBRARIES
      //  - Case B (environmentVariables: { MTL_HUD_ENABLED: '1' }): supervisor deadlock guard strips MTL_HUD_ENABLED and substitutes DXVK_HUD='devinfo,fps,frametimes'
      const bottleName = 'DeadlockGuardBottle';
      const bottleDir = createSyntheticBottle(hardenedRunner.bottlesDir, bottleName);
      hardenedRunner.layer.availableBottles = [bottleName];
      const gameExe = path.join(bottleDir, 'drive_c', 'SynthVulkan64.exe');
      fs.writeFileSync(
        gameExe,
        buildSyntheticPeBuffer({
          arch: 'x64',
          largeAddressAware: true,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'vulkan-1.dll'],
        })
      );

      const guardedSpawns: Array<Record<string, string | undefined>> = [];
      const guardResA = await supervisor.launchGame(
        {
          gameId: 'custom:deadlock-guard-a',
          title: 'Synthetic Vulkan Benchmark 64',
          platformId: 'custom',
          installPath: path.dirname(gameExe),
          executablePath: gameExe,
          launchConfig: {
            compatibilityLayer: 'crossover',
            wineBottleName: bottleName,
            winePrefixPath: bottleDir,
            crossoverGraphicsBackend: 'dxvk',
            metalHud: true,
          },
        },
        {
          platform: 'darwin',
          homedir: hardenedRunner.homedir,
          customApplicationsDir: hardenedRunner.appsDir,
          userDataDir: path.join(testTmpDir, 'userdata-guard'),
          layers: [hardenedRunner.layer],
          skipRegistrySpawn: true,
          gameSpawnFn: (_cmd: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
            guardedSpawns.push({ ...opts.env });
            return new MockChildProcess(54001);
          },
        }
      );

      expect(guardResA.success).toBe(true);
      expect(guardedSpawns).toHaveLength(1);
      expect(guardedSpawns[0].MTL_HUD_ENABLED).toBeUndefined();
      expect(guardedSpawns[0].DXVK_HUD).toBe('devinfo,fps,frametimes');
      expect(guardedSpawns[0].DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(String(guardedSpawns[0].CX_ENV || '')).not.toContain('MTL_HUD_ENABLED=1');
      await supervisor.finalizeGameSession('custom:deadlock-guard-a', {
        skipPostSessionCloudSync: true,
      });

      const guardResB = await supervisor.launchGame(
        {
          gameId: 'custom:deadlock-guard-b',
          title: 'Synthetic Vulkan Benchmark 64',
          platformId: 'custom',
          installPath: path.dirname(gameExe),
          executablePath: gameExe,
          launchConfig: {
            compatibilityLayer: 'crossover',
            wineBottleName: bottleName,
            winePrefixPath: bottleDir,
            crossoverGraphicsBackend: 'dxvk',
            environmentVariables: {
              MTL_HUD_ENABLED: '1',
            },
          },
        },
        {
          platform: 'darwin',
          homedir: hardenedRunner.homedir,
          customApplicationsDir: hardenedRunner.appsDir,
          userDataDir: path.join(testTmpDir, 'userdata-guard-b'),
          layers: [hardenedRunner.layer],
          skipRegistrySpawn: true,
          gameSpawnFn: (_cmd: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
            guardedSpawns.push({ ...opts.env });
            return new MockChildProcess(54002);
          },
        }
      );

      expect(guardResB.success).toBe(true);
      expect(guardedSpawns).toHaveLength(2);
      expect(guardedSpawns[1].MTL_HUD_ENABLED).toBeUndefined();
      expect(guardedSpawns[1].DXVK_HUD).toBe('devinfo,fps,frametimes');
      expect(String(guardedSpawns[1].CX_ENV || '')).not.toContain('MTL_HUD_ENABLED=1');
      await supervisor.finalizeGameSession('custom:deadlock-guard-b', {
        skipPostSessionCloudSync: true,
      });

      // 3e. Opt-in audio preload: default launch leaves preload unset on entitled runner;
      // audioBufferClamp: true injects libone_metal_preload.dylib (in CX_ENV for CrossOver Perl wrapper, or DYLD_INSERT_LIBRARIES for direct Mach-O)
      const entitledBottle = createSyntheticBottle(entitledRunner.bottlesDir, 'EntitledBottle');
      entitledRunner.layer.availableBottles = ['EntitledBottle'];

      const defaultEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        entitledRunner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: 'EntitledBottle',
          winePrefixPath: entitledBottle,
        },
        defaultEnv,
        {
          platform: 'darwin',
          homedir: path.join(testTmpDir, 'home-entitled'),
          userDataDir: path.join(testTmpDir, 'userdata-entitled'),
          skipRegistrySpawn: true,
        }
      );
      expect(defaultEnv.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(String(defaultEnv.CX_ENV || '')).not.toContain('libone_metal_preload.dylib');

      const optInCxEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        entitledRunner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: 'EntitledBottle',
          winePrefixPath: entitledBottle,
          audioBufferClamp: true,
        },
        optInCxEnv,
        {
          platform: 'darwin',
          homedir: path.join(testTmpDir, 'home-entitled'),
          userDataDir: path.join(testTmpDir, 'userdata-entitled'),
          enableAudioBufferClamp: true,
          skipRegistrySpawn: true,
        }
      );
      // CrossOver Perl wrapper moves DYLD_INSERT_LIBRARIES into CX_ENV so SIP /usr/bin/perl never strips it
      expect(optInCxEnv.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(String(optInCxEnv.CX_ENV || '')).toContain('libone_metal_preload.dylib');

      const optInDirectMachOEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        {
          id: 'wine-adhoc-macho',
          name: 'Open-Source Wine',
          type: 'wine',
          binaryPath: adhocBin,
        },
        {
          compatibilityLayer: 'wine',
          winePrefixPath: entitledBottle,
          audioBufferClamp: true,
        },
        optInDirectMachOEnv,
        {
          platform: 'darwin',
          homedir: path.join(testTmpDir, 'home-entitled'),
          userDataDir: path.join(testTmpDir, 'userdata-entitled'),
          enableAudioBufferClamp: true,
          skipBottleProvisioning: true,
          skipRegistrySpawn: true,
        }
      );
      expect(String(optInDirectMachOEnv.DYLD_INSERT_LIBRARIES || '')).toContain(
        'libone_metal_preload.dylib'
      );
    });

    it('compiles and runs one_metal_preload.c under Host Clang -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined verifying audio_client_timer Mach real-time promotion and helper argv/env skip', () => {
      if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/clang')) {
        return;
      }

      const preloadSourcePath = path.join(REPO_ROOT, 'electron', 'helpers', 'one_metal_preload.c');
      const harnessCPath = path.join(testTmpDir, 'preload_rt_audio_asan_test.c');
      const harnessBinPath = path.join(testTmpDir, 'preload_rt_audio_asan_test');

      const harnessSource = `
#include <assert.h>
#include <mach/mach.h>
#include <mach/thread_policy.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_mock_policy_calls = 0;
static thread_policy_flavor_t g_last_flavor = 0;
static thread_time_constraint_policy_data_t g_last_policy;

static int g_mock_argc = 2;
static char *g_mock_argv_game[] = { "wineloader", "C:\\\\Games\\\\SynthGame32.exe", NULL };
static char *g_mock_argv_reg[] = { "wineloader", "C:\\\\windows\\\\system32\\\\reg.exe", NULL };
static char *g_mock_argv_boot[] = { "wineloader", "/prefix/drive_c/windows/system32/wineboot.exe", NULL };
static char **g_active_argv = g_mock_argv_game;

static kern_return_t mock_thread_policy_set(
    thread_act_t thread,
    thread_policy_flavor_t flavor,
    thread_policy_t policy_info,
    mach_msg_type_number_t count) {
  (void)thread;
  g_mock_policy_calls += 1;
  g_last_flavor = flavor;
  if (flavor == THREAD_TIME_CONSTRAINT_POLICY &&
      count == THREAD_TIME_CONSTRAINT_POLICY_COUNT &&
      policy_info != NULL) {
    memcpy(&g_last_policy, policy_info, sizeof(g_last_policy));
  }
  return KERN_SUCCESS;
}

static int *mock_ns_get_argc(void) {
  return &g_mock_argc;
}

static char ***mock_ns_get_argv(void) {
  return &g_active_argv;
}

#define thread_policy_set mock_thread_policy_set
#define _NSGetArgc mock_ns_get_argc
#define _NSGetArgv mock_ns_get_argv

#include ${JSON.stringify(preloadSourcePath)}

int main(void) {
  /* 1. Helper process detection: game.exe -> 0, reg.exe -> 1, wineboot.exe -> 1, ONE_LAUNCHER_SUPPRESS_PRELOAD=1 -> 1 */
  unsetenv("ONE_LAUNCHER_SUPPRESS_PRELOAD");
  g_active_argv = g_mock_argv_game;
  assert(is_non_gui_wine_helper_process() == 0);

  g_active_argv = g_mock_argv_reg;
  assert(is_non_gui_wine_helper_process() == 1);

  g_active_argv = g_mock_argv_boot;
  assert(is_non_gui_wine_helper_process() == 1);

  g_active_argv = g_mock_argv_game;
  setenv("ONE_LAUNCHER_SUPPRESS_PRELOAD", "1", 1);
  assert(is_non_gui_wine_helper_process() == 1);
  unsetenv("ONE_LAUNCHER_SUPPRESS_PRELOAD");

  /* 2. Non-audio thread name must NOT trigger Mach real-time promotion */
  unsetenv("ONE_LAUNCHER_AUDIO_RT_THREAD");
  g_mock_policy_calls = 0;
  int rc_worker = one_launcher_pthread_setname_np("synth_render_worker");
  assert(rc_worker == 0);
  assert(g_mock_policy_calls == 0);

  /* 3. WinePulse/CoreAudio "audio_client_timer" MUST promote to THREAD_TIME_CONSTRAINT_POLICY */
  int rc_audio = one_launcher_pthread_setname_np("audio_client_timer");
  assert(rc_audio == 0);
  assert(g_mock_policy_calls == 1);
  assert(g_last_flavor == THREAD_TIME_CONSTRAINT_POLICY);
  assert(g_last_policy.period > 0);
  assert(g_last_policy.computation > 0);
  assert(g_last_policy.computation < g_last_policy.period);
  assert(g_last_policy.constraint == g_last_policy.period);
  assert(g_last_policy.preemptible == 1);

  /* 4. ONE_LAUNCHER_AUDIO_RT_THREAD=0 disables promotion cleanly */
  setenv("ONE_LAUNCHER_AUDIO_RT_THREAD", "0", 1);
  int rc_disabled = one_launcher_pthread_setname_np("audio_client_timer");
  assert(rc_disabled == 0);
  assert(g_mock_policy_calls == 1);
  unsetenv("ONE_LAUNCHER_AUDIO_RT_THREAD");

  /* 5. NULL thread name safety under UBSan/ASan */
  (void)one_launcher_pthread_setname_np(NULL);

  printf("PASS_PRELOAD_RT_AUDIO_ASAN\\n");
  return 0;
}
`;
      fs.writeFileSync(harnessCPath, harnessSource, 'utf8');

      execFileSync(
        '/usr/bin/clang',
        [
          '-std=c11',
          '-O1',
          '-g',
          '-fsanitize=address,undefined',
          '-fno-omit-frame-pointer',
          '-Wall',
          '-Wextra',
          '-Werror',
          harnessCPath,
          '-o',
          harnessBinPath,
        ],
        { stdio: 'pipe' }
      );

      const stdout = execFileSync(harnessBinPath, [], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1',
          UBSAN_OPTIONS: 'print_stacktrace=1:halt_on_error=1',
        },
      });
      expect(stdout).toContain('PASS_PRELOAD_RT_AUDIO_ASAN');
    });
  });

  // --------------------------------------------------------------------------
  // 4. F-COMPAT-04 & Wave 1A B1: Shared Bottle cxbottle.conf, RetinaMode & EmulateModeset
  // --------------------------------------------------------------------------
  describe('4. F-COMPAT-04 & Wave 1A B1: Shared Bottle cxbottle.conf, Non-Destructive RetinaMode & Reference-Checked EmulateModeset', () => {
    it('keeps auto PE32 backend routing out of shared cxbottle.conf, preserves/restores RetinaMode="y", and reference-checks explorer.exe EmulateModeset across bottle games', async () => {
      const runner = createSyntheticCrossOverRunner(path.join(testTmpDir, 'cx-shared'));
      const bottleName = 'SharedBottle';
      const bottleDir = createSyntheticBottle(runner.bottlesDir, bottleName, {
        userRegExtra: [
          '[Software\\\\Wine\\\\Mac Driver]',
          '"RetinaMode"="y"',
          '',
          '[Software\\\\Wine\\\\AppDefaults\\\\otherlegacy32.exe\\\\X11 Driver]',
          '"EmulateModeset"="y"',
          '',
          '[Software\\\\Wine\\\\AppDefaults\\\\explorer.exe\\\\X11 Driver]',
          '"EmulateModeset"="y"',
          '',
        ].join('\n'),
      });
      runner.layer.availableBottles = [bottleName];

      // 4a. Auto-routed 32-bit DX9 game -> env.CX_GRAPHICS_BACKEND='wined3d', BUT shared cxbottle.conf stays untouched!
      const dx9Pe32Path = path.join(bottleDir, 'drive_c', 'SynthDx9_32.exe');
      fs.writeFileSync(
        dx9Pe32Path,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: false,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'd3d9.dll'],
        })
      );

      const autoEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        runner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: bottleName,
          winePrefixPath: bottleDir,
          crossoverGraphicsBackend: 'auto',
          crossoverHighResolutionMode: undefined, // Bottle Default -> must NOT delete RetinaMode="y"
        },
        autoEnv,
        {
          platform: 'darwin',
          homedir: runner.homedir,
          userDataDir: path.join(testTmpDir, 'userdata-shared'),
          peCapabilities: binaryInspectors.resolveEffectiveGameExecutableCapabilities(dx9Pe32Path),
          exeName: 'SynthDx9_32.exe',
          skipRegistrySpawn: true,
        }
      );

      expect(autoEnv.CX_GRAPHICS_BACKEND).toBe('wined3d');
      const confAfterAuto = fs.readFileSync(path.join(bottleDir, 'cxbottle.conf'), 'utf8');
      expect(confAfterAuto).not.toContain('CX_GRAPHICS_BACKEND');

      let userReg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(userReg).toContain('"RetinaMode"="y"');

      // 4b. Legacy DirectDraw 32-bit game temporarily forces RetinaMode="n" and records OneLauncherPriorRetina="y"
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        'SynthDdraw32.exe',
        {
          crossoverGraphicsBackend: 'wined3d',
          crossoverHighResolutionMode: undefined,
        },
        {
          usesLegacyDirectDraw: true,
          enableLegacyDisplayModeSynthesis: true,
          skipRegistrySpawn: true,
        }
      );
      userReg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(userReg).toContain('"RetinaMode"="n"');
      expect(userReg).toContain('"OneLauncherManagedRetina"="1"');
      expect(userReg).toContain('"OneLauncherPriorRetina"="y"');

      // 4c. Subsequent 64-bit game in the SAME shared bottle with crossoverHighResolutionMode: undefined:
      //  - Restores RetinaMode="y" and removes OneLauncherManagedRetina / OneLauncherPriorRetina!
      //  - Preserves explorer.exe\X11 Driver "EmulateModeset"="y" because otherlegacy32.exe still needs it!
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        'SynthModern64.exe',
        {
          crossoverGraphicsBackend: 'auto',
          crossoverHighResolutionMode: undefined,
          emulateModeset: undefined,
        },
        {
          usesLegacyDirectDraw: false,
          enableLegacyDisplayModeSynthesis: false,
          skipRegistrySpawn: true,
        }
      );
      userReg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(userReg).toContain('"RetinaMode"="y"');
      expect(userReg).not.toContain('"OneLauncherManagedRetina"');
      expect(userReg).not.toContain('"OneLauncherPriorRetina"');
      expect(userReg).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\explorer\.exe\\\\X11 Driver\][^\[]*"EmulateModeset"="y"/s
      );

      // 4d. Once otherlegacy32.exe AND synthddraw32.exe clear EmulateModeset, explorer.exe\X11 Driver EmulateModeset is removed!
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        'SynthDdraw32.exe',
        { emulateModeset: false },
        { enableLegacyDisplayModeSynthesis: false, skipRegistrySpawn: true }
      );
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        'otherlegacy32.exe',
        { emulateModeset: false },
        { enableLegacyDisplayModeSynthesis: false, skipRegistrySpawn: true }
      );
      userReg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      const explorerBlockMatch = userReg.match(
        /\[Software\\\\Wine\\\\AppDefaults\\\\explorer\.exe\\\\X11 Driver\]([^\[]*)/
      );
      expect(explorerBlockMatch?.[1] || '').not.toContain('"EmulateModeset"="y"');
    });
  });

  // --------------------------------------------------------------------------
  // 5. F-COMPAT-05 & F-COMPAT-10: Coalesced Live wineserver Sync + win32 GOG 64-Bit Registry Parity
  // --------------------------------------------------------------------------
  describe('5. F-COMPAT-05 & F-COMPAT-10: Coalesced Live wineserver Sync + win32 GOG 64-Bit HKLM\\Software Parity', () => {
    it('coalesces all user.reg/system.reg upserts and value deletions into ONE reg.exe import on active bottles, and writes dual Wow6432Node + native HKLM\\Software keys on win32 GOG scripts', async () => {
      // 5a. Active bottle live sync coalescing in applyCrossOverPerGameSettings (homedir omitted so live sync runs!)
      const runner = createSyntheticCrossOverRunner(path.join(testTmpDir, 'cx-livesync'));
      const bottleDir = createSyntheticBottle(runner.bottlesDir, 'LiveSyncBottle', {
        userRegExtra: [
          '[Software\\\\Wine\\\\Mac Driver]',
          '"RetinaMode"="n"',
          '"OneLauncherManagedRetina"="1"',
          '"OneLauncherPriorRetina"="y"',
          '',
          '[Software\\\\Wine\\\\AppDefaults\\\\synthgame64.exe\\\\Direct3D]',
          '"VideoMemorySize"="1536"',
          '',
        ].join('\n'),
      });

      const liveRegImports: Array<{ bin: string; args: string[]; importedRegText: string }> = [];
      const applied = macNativeInstaller.applyCrossOverPerGameSettings(
        bottleDir,
        'SynthGame64.exe',
        {
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverHighResolutionMode: undefined, // triggers restore of RetinaMode="y" + deletion of marker values
          emulateModeset: true,
          forceLargeAddressAware: true,
        },
        {
          wineBinary: runner.winePerlPath,
          layerType: 'crossover',
          is64Bit: true,
          wineserverActive: true,
          skipLiveWineRegSync: false,
          userDataDir: path.join(testTmpDir, 'userdata-livesync'),
          maxWidth: 3024,
          maxHeight: 1964,
          logicalWidth: 1512,
          logicalHeight: 982,
          execFileFn: (
            bin: string,
            args: string[],
            _opts: unknown,
            cb?: (err: Error | null, stdout: string, stderr: string) => void
          ) => {
            const regIdx = args.indexOf('import');
            const regPath = regIdx >= 0 ? args[regIdx + 1] : '';
            const importedRegText =
              regPath && fs.existsSync(regPath) ? fs.readFileSync(regPath, 'utf16le') : '';
            liveRegImports.push({ bin, args: [...args], importedRegText });
            if (cb) cb(null, '', '');
          },
        }
      );

      expect(applied.CX_GRAPHICS_BACKEND).toBe('d3dmetal');
      const pendingSync = engineStateRegistry.pendingWineRegSyncByPrefix.get(
        path.resolve(bottleDir)
      );
      expect(pendingSync).toBeTruthy();
      await pendingSync;

      // Every HKCU upsert, HKLM upsert (ServicesPipeTimeout + Display Modes), and value deletion ("=-") batched into ONE reg.exe import!
      expect(liveRegImports).toHaveLength(1);
      expect(liveRegImports[0].args).toContain('reg.exe');
      expect(liveRegImports[0].args).toContain('import');
      expect(liveRegImports[0].importedRegText).toContain('Windows Registry Editor Version 5.00');
      expect(liveRegImports[0].importedRegText).toContain('[HKEY_CURRENT_USER\\Software\\Wine\\Mac Driver]');
      expect(liveRegImports[0].importedRegText).toContain('"RetinaMode"="y"');
      expect(liveRegImports[0].importedRegText).toContain('"OneLauncherManagedRetina"=-');
      expect(liveRegImports[0].importedRegText).toContain('"VideoMemorySize"=-');
      expect(liveRegImports[0].importedRegText).toContain(
        '[HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control]'
      );

      // 5a-noop (D1): Calling upsertWineSystemRegKeysBatch again with identical entries is a 0-write no-op (updated: false)
      const noopRes = firstPartyRegistration.upsertWineSystemRegKeysBatch(
        bottleDir,
        [{ subKeyPath: 'Software\\Wine\\Mac Driver', entries: [['RetinaMode', { type: 'sz', value: 'y' }]] }],
        { regFilePath: path.join(bottleDir, 'user.reg'), skipLiveWineRegSync: true }
      );
      expect(noopRes.updated).toBe(false);

      // 5b. F-COMPAT-10: executeGogGameScript on win32 emits BOTH Wow6432Node and native 64-bit HKLM\Software keys
      const gogWinInstallDir = path.join(testTmpDir, 'gog-win32-game');
      fs.mkdirSync(gogWinInstallDir, { recursive: true });
      fs.writeFileSync(
        path.join(gogWinInstallDir, 'goggame-19990077.script'),
        JSON.stringify({
          actions: [
            {
              name: 'setup_registry',
              install: {
                action: 'setRegistry',
                arguments: {
                  root: 'HKEY_LOCAL_MACHINE',
                  subkey: 'Software\\SyntheticStudio\\SynthChronicles',
                  valueName: 'InstallPath',
                  valueData: '{app}',
                  valueType: 'string',
                },
              },
            },
          ],
        }),
        'utf8'
      );

      const winRegAddCalls: string[][] = [];
      const gogWinResult = await gogScriptInterpreter.executeGogGameScript(gogWinInstallDir, {
        gameId: '19990077',
        platform: 'win32',
        language: 'en-US',
        execFileFn: (
          bin: string,
          args: string[],
          _opts: unknown,
          cb?: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (/^reg(?:\.exe)?$/i.test(bin)) {
            winRegAddCalls.push([...args]);
          }
          if (cb) cb(null, '', '');
        },
      });

      expect(gogWinResult.executed).toBe(true);
      expect(gogWinResult.registryKeysApplied).toBeGreaterThanOrEqual(4);
      const writtenRegKeys = winRegAddCalls.map((a) => a[1]);
      expect(writtenRegKeys).toContain(
        'HKLM\\Software\\Wow6432Node\\SyntheticStudio\\SynthChronicles'
      );
      expect(writtenRegKeys).toContain('HKLM\\Software\\SyntheticStudio\\SynthChronicles');
      expect(writtenRegKeys).toContain(
        'HKCU\\Software\\Wow6432Node\\SyntheticStudio\\SynthChronicles'
      );
      expect(writtenRegKeys).toContain('HKCU\\Software\\SyntheticStudio\\SynthChronicles');

      // 5c. executeGogGameScript on darwin active bottle coalesces HKLM + HKCU + binary hex into ONE reg.exe import
      const gogMacBottle = createSyntheticBottle(runner.bottlesDir, 'GogScriptBottle');
      const gogMacGameDir = path.join(gogMacBottle, 'drive_c', 'GOG Games', 'SynthChronicles');
      fs.mkdirSync(gogMacGameDir, { recursive: true });
      fs.writeFileSync(
        path.join(gogMacGameDir, 'goggame-19990078.script'),
        JSON.stringify({
          actions: [
            {
              name: 'reg_hklm',
              install: {
                action: 'setRegistry',
                arguments: {
                  root: 'HKLM',
                  subkey: 'Software\\SyntheticStudio\\SynthChronicles',
                  valueName: 'InstallDir',
                  valueData: '{app}',
                  valueType: 'string',
                },
              },
            },
            {
              name: 'reg_hkcu_bin',
              install: {
                action: 'setRegistry',
                arguments: {
                  root: 'HKCU',
                  subkey: 'Software\\SyntheticStudio\\SynthChronicles',
                  valueName: 'ConfigBlob',
                  valueData: 'deadbeef',
                  valueType: 'binary',
                },
              },
            },
          ],
        }),
        'utf8'
      );

      const gogMacLiveImports: string[] = [];
      await gogScriptInterpreter.executeGogGameScript(gogMacGameDir, {
        bottleDir: gogMacBottle,
        gameId: '19990078',
        platform: 'darwin',
        wineBinary: runner.winePerlPath,
        layerType: 'crossover',
        wineserverActive: true,
        userDataDir: path.join(testTmpDir, 'userdata-gogmac'),
        execFileFn: (
          _bin: string,
          args: string[],
          _opts: unknown,
          cb?: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          const idx = args.indexOf('import');
          const regFile = idx >= 0 ? args[idx + 1] : '';
          if (regFile && fs.existsSync(regFile)) {
            gogMacLiveImports.push(fs.readFileSync(regFile, 'utf16le'));
          }
          if (cb) cb(null, '', '');
        },
      });

      expect(gogMacLiveImports).toHaveLength(1);
      expect(gogMacLiveImports[0]).toContain(
        '[HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\SyntheticStudio\\SynthChronicles]'
      );
      expect(gogMacLiveImports[0]).toContain(
        '[HKEY_CURRENT_USER\\Software\\SyntheticStudio\\SynthChronicles]'
      );
      expect(gogMacLiveImports[0]).toContain('"ConfigBlob"=hex:de,ad,be,ef');
    });
  });

  // --------------------------------------------------------------------------
  // 6. F-COMPAT-06 & Wave 1C: 32-Bit Bottled Performance, Upscaling, FPS, DLSS 26.3 Gate & Force LAA
  // --------------------------------------------------------------------------
  describe('6. F-COMPAT-06 & Wave 1C: 32-Bit Bottled Performance, DXVK_CONFIG_FILE, MetalFX Upscale, FPS Cap, DLSS 26.3 Gate & Force LAA', () => {
    it('materializes 3-tier DXVK_CONFIG_FILE VRAM budgets, 32-bit DXMT ignoreMapFlagNoWait, MetalFX spatial upscale, FPS caps, shader cache/zero-log vars, CrossOver 26.3 Sequoia/Tahoe DLSS gate, and opt-in forceLargeAddressAware', async () => {
      const runner = createSyntheticCrossOverRunner(path.join(testTmpDir, 'cx-perf'), {
        version: '26.3.0',
      });
      const bottleName = 'PerfBottle';
      const bottleDir = createSyntheticBottle(runner.bottlesDir, bottleName);
      runner.layer.availableBottles = [bottleName];

      const pe32NonLaa = path.join(bottleDir, 'drive_c', 'Games', 'Tier1', 'Tier1NonLaa32.exe');
      const pe32Laa = path.join(bottleDir, 'drive_c', 'Games', 'Tier2', 'Tier2Laa32.exe');
      const pe64 = path.join(bottleDir, 'drive_c', 'Games', 'Tier3', 'Tier3Game64.exe');
      for (const p of [pe32NonLaa, pe32Laa, pe64]) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
      }

      fs.writeFileSync(
        pe32NonLaa,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: false,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'd3d11.dll', 'dxgi.dll'],
        })
      );
      fs.writeFileSync(
        pe32Laa,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: true,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'd3d11.dll', 'dxgi.dll'],
        })
      );
      fs.writeFileSync(
        pe64,
        buildSyntheticPeBuffer({
          arch: 'x64',
          largeAddressAware: true,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'd3d12.dll', 'dxgi.dll'],
        })
      );

      const userDataDir = path.join(testTmpDir, 'userdata-perf');
      const homedir = runner.homedir;
      const pe32NonLaaCaps =
        binaryInspectors.resolveEffectiveGameExecutableCapabilities(pe32NonLaa);
      const pe32LaaCaps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(pe32Laa);
      const pe64Caps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(pe64);

      // Tier 1: PE32 non-LAA on dxvk + preferredMaxFrameRate: 90
      const tier1DxvkEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        runner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: bottleName,
          winePrefixPath: bottleDir,
          crossoverGraphicsBackend: 'dxvk',
          preferredMaxFrameRate: 90,
        },
        tier1DxvkEnv,
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          peCapabilities: pe32NonLaaCaps,
          exeName: 'Tier1NonLaa32.exe',
          skipRegistrySpawn: true,
        }
      );
      expect(tier1DxvkEnv.MVK_CONFIG_RESUME_LOST_DEVICE).toBe('1');
      expect(tier1DxvkEnv.DXVK_FRAME_RATE).toBe('90');
      expect(tier1DxvkEnv.DXVK_STATE_CACHE_PATH).toBeTruthy();
      expect(tier1DxvkEnv.DXVK_LOG_LEVEL).toBe('none');
      expect(tier1DxvkEnv.DXVK_LOG_PATH).toBe('none');
      expect(tier1DxvkEnv.DXMT_LOG_LEVEL).toBe('none');
      expect(tier1DxvkEnv.DXMT_LOG_PATH).toBe('none');
      expect(tier1DxvkEnv.CX_FWD_COMPAT_GL_CTX).toBe('1');

      const tier1Conf = fs.readFileSync(String(tier1DxvkEnv.DXVK_CONFIG_FILE), 'utf8');
      expect(tier1Conf).toContain('\n');
      expect(tier1Conf).toContain('d3d9.maxAvailableMemory = 1536');
      expect(tier1Conf).toContain('dxgi.maxDeviceMemory = 1536');
      expect(tier1Conf).toContain('d3d9.maxFrameRate = 90');
      expect(tier1Conf).toContain('dxgi.maxFrameRate = 90');
      expect(fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8')).toContain(
        '"VideoMemorySize"="1536"'
      );

      // Tier 1 on DXMT + metalfxSpatialUpscaleFactor: 1.5 + preferredMaxFrameRate: 75 + crossoverDlss: true (PE32 must block DLSS!)
      const tier1DxmtEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        runner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: bottleName,
          winePrefixPath: bottleDir,
          crossoverGraphicsBackend: 'dxmt',
          metalfxSpatialUpscaleFactor: 1.5,
          preferredMaxFrameRate: 75,
          crossoverDlss: true,
        },
        tier1DxmtEnv,
        {
          platform: 'darwin',
          darwinKernelMajor: 25,
          homedir,
          userDataDir,
          peCapabilities: pe32NonLaaCaps,
          exeName: 'Tier1NonLaa32.exe',
          skipRegistrySpawn: true,
        }
      );
      expect(tier1DxmtEnv.DXMT_METALFX_SPATIAL_SWAPCHAIN).toBe('1');
      expect(String(tier1DxmtEnv.DXMT_CONFIG || '')).toContain('d3d11.ignoreMapFlagNoWait = True');
      expect(String(tier1DxmtEnv.DXMT_CONFIG || '')).toContain('d3d11.metalSpatialUpscaleFactor = 1.5');
      expect(String(tier1DxmtEnv.DXMT_CONFIG || '')).toContain('d3d11.preferredMaxFrameRate = 75');
      // 32-bit PE32 forces DLSS off even when crossoverDlss: true
      expect(tier1DxmtEnv.D3DM_ENABLE_METALFX).toBe('0');
      expect(tier1DxmtEnv.DXMT_ENABLE_NVEXT).toBe('0');
      // VideoMemorySize="1536" removed on DXMT
      expect(
        fs
          .readFileSync(path.join(bottleDir, 'user.reg'), 'utf8')
          .match(/\[Software\\\\Wine\\\\AppDefaults\\\\tier1nonlaa32\.exe\\\\Direct3D\]([^\[]*)/)?.[1] || ''
      ).not.toContain('"VideoMemorySize"');

      // Opt-in forceLargeAddressAware: true on non-LAA PE32 lifts Tier 1 (1536) -> Tier 2 (2048/3072) and writes LargeAddressAware=dword:00000001
      const forcedLaaEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        runner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: bottleName,
          winePrefixPath: bottleDir,
          crossoverGraphicsBackend: 'dxvk',
          forceLargeAddressAware: true,
        },
        forcedLaaEnv,
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          totalMemoryBytes: 16 * 1024 * 1024 * 1024,
          peCapabilities: pe32NonLaaCaps,
          exeName: 'Tier1NonLaa32.exe',
          skipRegistrySpawn: true,
        }
      );
      const forcedLaaConf = fs.readFileSync(String(forcedLaaEnv.DXVK_CONFIG_FILE), 'utf8');
      expect(forcedLaaConf).toContain('d3d9.maxAvailableMemory = 2048');
      expect(forcedLaaConf).toContain('dxgi.maxDeviceMemory = 3072');
      expect(fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8')).toContain(
        '"LargeAddressAware"=dword:00000001'
      );

      // Tier 2 native LAA PE32 on dxvk -> 2048 / 3072
      const tier2Env: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        runner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: bottleName,
          winePrefixPath: bottleDir,
          crossoverGraphicsBackend: 'dxvk',
        },
        tier2Env,
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          totalMemoryBytes: 16 * 1024 * 1024 * 1024,
          peCapabilities: pe32LaaCaps,
          exeName: 'Tier2Laa32.exe',
          skipRegistrySpawn: true,
        }
      );
      const tier2Conf = fs.readFileSync(String(tier2Env.DXVK_CONFIG_FILE), 'utf8');
      expect(tier2Conf).toContain('d3d9.maxAvailableMemory = 2048');
      expect(tier2Conf).toContain('dxgi.maxDeviceMemory = 3072');

      // Tier 3 PE32+ 64-bit on dxvk -> d3d9.maxAvailableMemory = 4096 (no 1536/3072 dxgi cap)
      const tier3DxvkEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        runner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: bottleName,
          winePrefixPath: bottleDir,
          crossoverGraphicsBackend: 'dxvk',
        },
        tier3DxvkEnv,
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          peCapabilities: pe64Caps,
          exeName: 'Tier3Game64.exe',
          skipRegistrySpawn: true,
        }
      );
      const tier3Conf = fs.readFileSync(String(tier3DxvkEnv.DXVK_CONFIG_FILE), 'utf8');
      expect(tier3Conf).toContain('d3d9.maxAvailableMemory = 4096');
      expect(tier3Conf).not.toContain('dxgi.maxDeviceMemory = 1536');

      // CrossOver 26.3.0 DLSS Kernel Gate on 64-bit PE32+:
      // Sequoia (darwinKernelMajor: 24) -> DXMT_ENABLE_NVEXT='1', D3DM_ENABLE_METALFX='0'
      // Tahoe (darwinKernelMajor: 25) -> DXMT_ENABLE_NVEXT='1', D3DM_ENABLE_METALFX='1' + D3DM_MAX_FPS='120'
      const sequoiaDlssEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        runner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: bottleName,
          winePrefixPath: bottleDir,
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverDlss: true,
          preferredMaxFrameRate: 120,
        },
        sequoiaDlssEnv,
        {
          platform: 'darwin',
          arch: 'arm64',
          darwinKernelMajor: 24,
          homedir,
          userDataDir,
          peCapabilities: pe64Caps,
          exeName: 'Tier3Game64.exe',
          skipRegistrySpawn: true,
        }
      );
      expect(sequoiaDlssEnv.DXMT_ENABLE_NVEXT).toBe('1');
      expect(sequoiaDlssEnv.D3DM_ENABLE_METALFX).toBe('0');
      expect(sequoiaDlssEnv.D3DM_MAX_FPS).toBe('120');

      const tahoeDlssEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        runner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: bottleName,
          winePrefixPath: bottleDir,
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverDlss: true,
        },
        tahoeDlssEnv,
        {
          platform: 'darwin',
          arch: 'arm64',
          darwinKernelMajor: 25,
          homedir,
          userDataDir,
          peCapabilities: pe64Caps,
          exeName: 'Tier3Game64.exe',
          skipRegistrySpawn: true,
        }
      );
      expect(tahoeDlssEnv.DXMT_ENABLE_NVEXT).toBe('1');
      expect(tahoeDlssEnv.D3DM_ENABLE_METALFX).toBe('1');
      expect(tahoeDlssEnv.MVK_CONFIG_LOG_LEVEL).toBe('2');

      // Native Vulkan title on 'auto' receives MVK_CONFIG_RESUME_LOST_DEVICE='1' + MVK_CONFIG_LOG_LEVEL='2' (D3)
      const vkAutoEnv: Record<string, string | undefined> = {};
      await macNativeInstaller.ensureCompatibilityLayerReady(
        runner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: bottleName,
          winePrefixPath: bottleDir,
          crossoverGraphicsBackend: 'auto',
        },
        vkAutoEnv,
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          peCapabilities: { ...pe64Caps, importsVulkan: true },
          exeName: 'SynthVulkan64.exe',
          skipRegistrySpawn: true,
        }
      );
      expect(vkAutoEnv.MVK_CONFIG_RESUME_LOST_DEVICE).toBe('1');
      expect(vkAutoEnv.MVK_CONFIG_LOG_LEVEL).toBe('2');
    });
  });

  // --------------------------------------------------------------------------
  // 7. F-COMPAT-07, F-COMPAT-08, F-COMPAT-09 & UI WCAG 2.2 AA
  // --------------------------------------------------------------------------
  describe('7. F-COMPAT-07, F-COMPAT-08, F-COMPAT-09 & UI WCAG 2.2 AA (GameLaunchConfigModal + launchConfigStore)', () => {
    it('discovers standalone runners, isolates Games/OneLauncher/Prefixes/default, omits --default on cxbottle --create, repairs bottle baseline/Valve/win10, and emits EmulateModeset telemetry', async () => {
      const mockHome = path.join(testTmpDir, 'home-runners');

      // Populate Homebrew GPTK + Whisky + Sikarugir + Kegworks + Mythic + Heroic prefix (must NEVER hijack Heroic!)
      const brewDirectGptk = path.join(mockHome, 'homebrew', 'bin', 'gameportingtoolkit');
      fs.mkdirSync(path.dirname(brewDirectGptk), { recursive: true });
      fs.writeFileSync(brewDirectGptk, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const whiskyBin = path.join(
        mockHome,
        'Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64'
      );
      const sikarugirBin = path.join(
        mockHome,
        'Library/Application Support/Sikarugir/Engines/WS12WineCX24.0.7/wswine.bundle/bin/wine64'
      );
      const kegEngineDirName = ['Keg', 'works'].join('');
      const kegBin = path.join(
        mockHome,
        `Library/Application Support/${kegEngineDirName}/Engines/WS11WineCX23.7.1/wswine.bundle/bin/wine64`
      );
      const mythicBin = path.join(
        mockHome,
        'Library/Application Support/Mythic/Libraries/Wine/bin/wine64'
      );
      for (const p of [whiskyBin, sikarugirBin, kegBin, mythicBin]) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }

      // Create Heroic default prefix on disk -> One Launcher MUST still isolate to Games/OneLauncher/Prefixes/default!
      fs.mkdirSync(path.join(mockHome, 'Games/Heroic/Prefixes/default/drive_c'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(mockHome, 'Games/Heroic/Prefixes/default/system.reg'),
        'WINE REGISTRY Version 2\n',
        'utf8'
      );
      // D4: resolveTargetBottleForFirstPartySync must NEVER select Games/Heroic/Prefixes/default as fallback
      const syncFallbackBottle = macNativeInstaller.resolveTargetBottleForFirstPartySync(
        { gameId: 'gog-999111', installPath: path.join(testTmpDir, 'external-gog-game') },
        'gog',
        { platform: 'darwin', homedir: mockHome, userDataDir: path.join(testTmpDir, 'userdata-runners') }
      );
      expect(String(syncFallbackBottle || '')).not.toContain('Heroic');

      const layers = macNativeInstaller.detectCompatibilityLayers({
        platform: 'darwin',
        homedir: mockHome,
        customApplicationsDir: path.join(testTmpDir, 'empty-apps'),
      });
      const gptkLayer = layers.find((l) => l.type === 'gptk');
      const wineLayer = layers.find((l) => l.type === 'wine');
      expect(gptkLayer).toBeTruthy();
      expect(wineLayer).toBeTruthy();

      // Verify each standalone community Wine manager binary is also discoverable in isolation
      for (const [labelFragment, binRel] of [
        ['Sikarugir', `Library/Application Support/Sikarugir/Engines/WS12WineCX24.0.7/wswine.bundle/bin/wine64`],
        [kegEngineDirName, `Library/Application Support/${kegEngineDirName}/Engines/WS11WineCX23.7.1/wswine.bundle/bin/wine64`],
        ['Mythic', `Library/Application Support/Mythic/Libraries/Wine/bin/wine64`],
      ] as const) {
        const isoHome = path.join(testTmpDir, `iso-${labelFragment.toLowerCase()}`);
        const isoBin = path.join(isoHome, binRel);
        fs.mkdirSync(path.dirname(isoBin), { recursive: true });
        fs.writeFileSync(isoBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const isoLayers = macNativeInstaller.detectCompatibilityLayers({
          platform: 'darwin',
          homedir: isoHome,
          customApplicationsDir: path.join(testTmpDir, 'empty-apps'),
        });
        expect(isoLayers.find((l) => l.type === 'wine')?.name).toContain(labelFragment);
      }

      // Provision standalone Wine prefix -> must create Games/OneLauncher/Prefixes/default (NOT Heroic!)
      const standaloneEnv: Record<string, string | undefined> = {};
      const standaloneRes = await macNativeInstaller.ensureCompatibilityLayerReady(
        wineLayer!,
        { compatibilityLayer: 'wine' },
        standaloneEnv,
        {
          platform: 'darwin',
          homedir: mockHome,
          userDataDir: path.join(testTmpDir, 'userdata-runners'),
          skipBottleProvisioning: true,
          skipRegistrySpawn: true,
        }
      );
      expect(standaloneRes.winePrefix).toBe(
        path.join(mockHome, 'Games/OneLauncher/Prefixes/default')
      );
      expect(String(standaloneRes.winePrefix)).not.toContain('Heroic');

      // Verify cxbottle --create NEVER passes --default in ensureCompatibilityLayerReady OR environmentProvisioner
      const cxRunner = createSyntheticCrossOverRunner(path.join(testTmpDir, 'cx-nodflt'));
      await macNativeInstaller.ensureCompatibilityLayerReady(
        cxRunner.layer,
        {
          compatibilityLayer: 'crossover',
          wineBottleName: 'SynthFreshBottle',
        },
        {},
        {
          platform: 'darwin',
          userDataDir: path.join(testTmpDir, 'userdata-nodflt'),
          skipRegistrySpawn: true,
          skipLiveWineRegSync: true,
          execFileFn: (
            file: string,
            args: string[],
            _opts: unknown,
            cb?: (err: Error | null, stdout?: string, stderr?: string) => void
          ) => {
            if (path.resolve(String(file)) === path.resolve(cxRunner.cxbottlePath)) {
              fs.appendFileSync(cxRunner.cxbottleLogPath, `${args.join(' ')}\n`, 'utf8');
            }
            if (typeof cb === 'function') cb(null, '', '');
          },
        }
      );
      expect(fs.existsSync(cxRunner.cxbottleLogPath)).toBe(true);
      const loggedCxbottleLine = fs.readFileSync(cxRunner.cxbottleLogPath, 'utf8').trim();
      expect(loggedCxbottleLine).toContain('--create');
      expect(loggedCxbottleLine).not.toContain('--default');

      const provisionerCxbottleCalls: string[][] = [];
      await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [
            {
              componentId: 'default_bottle',
              action: 'ensure_bottle',
              runnerType: 'crossover',
              bottleName: 'OneLauncherProvBottle',
            },
          ],
        },
        {
          platform: 'darwin',
          homedir: cxRunner.homedir,
          customApplicationsDir: cxRunner.appsDir,
          userDataDir: path.join(testTmpDir, 'userdata-prov'),
          execFileFn: (
            bin: string,
            args: string[],
            _opts: unknown,
            cb?: (err: Error | null, stdout: string, stderr: string) => void
          ) => {
            if (String(bin).endsWith('cxbottle')) {
              provisionerCxbottleCalls.push([...args]);
              createSyntheticBottle(cxRunner.bottlesDir, 'OneLauncherProvBottle');
            }
            if (cb) cb(null, '', '');
          },
        }
      );
      expect(provisionerCxbottleCalls.length).toBeGreaterThanOrEqual(1);
      for (const args of provisionerCxbottleCalls) {
        expect(args).toContain('--create');
        expect(args).not.toContain('--default');
      }

      // F-COMPAT-08: Bottle baseline FontSubstitutes, ServicesPipeTimeout, non-#link Wow6432Node\Valve repair & win7 -> win10 recovery
      const repairBottle = createSyntheticBottle(cxRunner.bottlesDir, 'RepairBottle', {
        userRegExtra: [
          '[Software\\\\Wine]',
          '"Version"="win7"',
          '',
          '[Software\\\\Valve\\\\Steam]',
          '"SteamPath"="c:/program files (x86)/steam"',
          '',
          '[Software\\\\Wow6432Node\\\\Valve\\\\Steam]',
          '"StaleShadow"="1"',
          '',
        ].join('\n'),
      });
      macNativeInstaller.applyCrossOverPerGameSettings(
        repairBottle,
        'SynthRepair64.exe',
        { crossoverGraphicsBackend: 'auto' },
        { is64Bit: true, skipRegistrySpawn: true }
      );
      const repairedUserReg = fs.readFileSync(path.join(repairBottle, 'user.reg'), 'utf8');
      const repairedSysReg = fs.readFileSync(path.join(repairBottle, 'system.reg'), 'utf8');
      expect(repairedUserReg).toContain('"Version"="win10"');
      // Non-#link [Software\\Wow6432Node\\Valve\\Steam] shadow removed while preserving [Software\\Valve\\Steam]
      expect(repairedUserReg).toContain('[Software\\\\Valve\\\\Steam]');
      expect(repairedUserReg).not.toContain('"StaleShadow"="1"');
      expect(repairedSysReg).toContain('"Palatino Linotype"="Palatino"');
      expect(repairedSysReg).toContain('"Segoe UI"="Helvetica Neue"');
      expect(repairedSysReg).toContain('"ServicesPipeTimeout"=dword:0000ea60');

      // F-COMPAT-09: >= 2 err:system:display_mode_changed lines on stderr emit EmulateModeset recommendation
      cxRunner.layer.availableBottles = ['RepairBottle'];
      const modeGameExe = path.join(repairBottle, 'drive_c', 'SynthModeChange32.exe');
      fs.writeFileSync(
        modeGameExe,
        buildSyntheticPeBuffer({ arch: 'x86', importedDlls: ['KERNEL32.dll', 'd3d9.dll'] })
      );

      let capturedChild: MockChildProcess | null = null;
      const stoppedEvents: Array<Record<string, any>> = [];
      const unsubSession = engineStateRegistry.onSessionUpdated((ev: Record<string, any>) => {
        if (ev.event === 'stopped') stoppedEvents.push(ev);
      });
      try {
        const modeRes = await supervisor.launchGame(
          {
            gameId: 'custom:mode-change-telemetry',
            title: 'Synthetic Mode Change 32',
            platformId: 'custom',
            installPath: path.dirname(modeGameExe),
            executablePath: modeGameExe,
            launchConfig: {
              compatibilityLayer: 'crossover',
              wineBottleName: 'RepairBottle',
              winePrefixPath: repairBottle,
            },
          },
          {
            platform: 'darwin',
            homedir: cxRunner.homedir,
            customApplicationsDir: cxRunner.appsDir,
            userDataDir: path.join(testTmpDir, 'userdata-mode'),
            layers: [cxRunner.layer],
            skipRegistrySpawn: true,
            gameSpawnFn: () => {
              capturedChild = new MockChildProcess(59001);
              return capturedChild;
            },
          }
        );

        expect(modeRes.success).toBe(true);
        expect(capturedChild).toBeTruthy();
        capturedChild!.stderr.emit(
          'data',
          Buffer.from(
            '0110:err:system:display_mode_changed Failed to apply mode 800x600\n0110:err:system:display_mode_changed Retrying mode switch\n',
            'utf8'
          )
        );

        const finalSummary = await supervisor.finalizeGameSession('custom:mode-change-telemetry', {
          skipPostSessionCloudSync: true,
        });
        expect(finalSummary?.recommendation).toBe(
          'Enable Display Mode Emulation (EmulateModeset) in Launch Configuration'
        );
        expect(stoppedEvents[0]?.recommendation).toBe(
          'Enable Display Mode Emulation (EmulateModeset) in Launch Configuration'
        );
      } finally {
        unsubSession();
      }
    });

    it('renders GameLaunchConfigModal across darwin (PE32 & PE32+) and win32 with 0 WCAG 2.2 AA violations and round-trips explicit false HUDs + new Pass-2 launchConfigStore fields', async () => {
      // Create isolated in-memory Storage for launchConfigStore + window.localStorage
      const storageMap = new Map<string, string>();
      const mockStorage: Storage = {
        get length() {
          return storageMap.size;
        },
        clear() {
          storageMap.clear();
        },
        getItem(k: string) {
          return storageMap.has(k) ? storageMap.get(k)! : null;
        },
        key(idx: number) {
          return Array.from(storageMap.keys())[idx] ?? null;
        },
        removeItem(k: string) {
          storageMap.delete(k);
        },
        setItem(k: string, v: string) {
          storageMap.set(k, String(v));
        },
      };

      const prevWindow = (globalThis as any).window;
      const prevLocalStorage = (globalThis as any).localStorage;
      const prevCustomEvent = (globalThis as any).CustomEvent;
      (globalThis as any).localStorage = mockStorage;
      if (!(globalThis as any).CustomEvent) {
        (globalThis as any).CustomEvent = class CustomEvent {
          type: string;
          detail: unknown;
          constructor(type: string, init?: { detail?: unknown }) {
            this.type = type;
            this.detail = init?.detail;
          }
        };
      }
      (globalThis as any).window = {
        localStorage: mockStorage,
        electronAPI: { platform: 'darwin' },
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      };

      try {
        // Seed launchConfigStore with pass-through fields + previously enabled HUDs to verify explicit false overwrite & pass-through preservation
        persistLocalLaunchConfigsToStorage({
          'syn-modal-pe32': {
            gameId: 'syn-modal-pe32',
            preferredPlatformId: 'gog',
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            wineBottleName: 'SynthBottle',
            crossoverGraphicsBackend: 'dxmt',
            metalHud: true,
            dxvkHud: true,
            metalfxSpatialUpscaleFactor: 1.5,
            preferredMaxFrameRate: 90,
            emulateModeset: true,
            forceLargeAddressAware: true,
            virtualDesktop: true,
            audioBufferClamp: true,
            advertiseAvx: false,
            platformConfigs: {
              gog: {
                launchMethod: 'compatibility_layer',
                compatibilityLayer: 'crossover',
                wineBottleName: 'SynthBottle',
                crossoverGraphicsBackend: 'dxmt',
                metalHud: true,
                dxvkHud: true,
                metalfxSpatialUpscaleFactor: 1.5,
                preferredMaxFrameRate: 90,
                emulateModeset: true,
                forceLargeAddressAware: true,
                virtualDesktop: true,
                audioBufferClamp: true,
                advertiseAvx: false,
              },
            },
          },
        });

        const storedInitial = getLaunchConfigFromStorage('syn-modal-pe32', 'gog');
        expect(storedInitial?.metalfxSpatialUpscaleFactor).toBe(1.5);
        expect(storedInitial?.preferredMaxFrameRate).toBe(90);
        expect(storedInitial?.emulateModeset).toBe(true);
        expect(storedInitial?.forceLargeAddressAware).toBe(true);
        expect(storedInitial?.virtualDesktop).toBe(true);
        expect(storedInitial?.audioBufferClamp).toBe(true);
        expect(storedInitial?.advertiseAvx).toBe(false);

        const singleD3dLayer: CompatibilityLayerInfo = {
          id: 'crossover-26-3',
          name: 'CrossOver',
          type: 'crossover',
          version: '26.3.0',
          binaryPath: '/tmp/synth-cx/bin/wine',
          bottlesDir: '/tmp/synth-cx/Bottles',
          availableBottles: ['SynthBottle'],
          supportsMetalFxDlssD3dMetal: true,
          supportsMetalFxDlssDxmt: true,
          availableD3DMetalVersions: [
            { id: '3', label: 'Bundled (v3.0)', version: '3.0', isDefault: true },
          ],
        };

        const synthGamePe32: CanonicalGame = {
          id: 'syn-modal-pe32',
          title: 'Synthetic Retro Tactics 32',
          sortTitle: 'Synthetic Retro Tactics 32',
          headerImage: '',
          developers: ['Synthetic Studio'],
          publishers: ['Synthetic Publisher'],
          genres: ['Strategy'],
          tags: [],
          platforms: [
            {
              platformId: 'gog',
              platformGameId: '19990101',
              installed: true,
              installPath: '/tmp/synth-cx/Bottles/SynthBottle/drive_c/Games/SynthTactics32',
              executablePath:
                '/tmp/synth-cx/Bottles/SynthBottle/drive_c/Games/SynthTactics32/SynthTactics32.exe',
            },
          ],
        };

        vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([singleD3dLayer]);
        vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([singleD3dLayer]);
        vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
        vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
        vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue({});
        vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
        vi.spyOn(launcherService, 'getLaunchConfig').mockImplementation((gid, plat) =>
          getLaunchConfigFromStorage(gid, plat)
        );
        vi.spyOn(launcherService, 'saveLaunchConfig').mockImplementation(async (cfg) => {
          persistLocalLaunchConfigsToStorage({ [cfg.gameId]: cfg });
        });
        vi.spyOn(launcherService, 'resolveEffectiveLaunchModePreview').mockReturnValue({
          effectiveMode: 'compatibility_layer',
          defaultLaunchMethod: 'compatibility_layer',
          availableModes: ['auto', 'compatibility_layer', 'direct'],
          detectedBuildType: 'windows_exe_on_mac',
          peArchitecture: 'x86',
          is32BitExecutable: true,
          executableArchitecture: 'x86',
          isInstalled: true,
          installPath: '/tmp/synth-cx/Bottles/SynthBottle/drive_c/Games/SynthTactics32',
          executablePath:
            '/tmp/synth-cx/Bottles/SynthBottle/drive_c/Games/SynthTactics32/SynthTactics32.exe',
          visibleSections: {
            compatibilityLayer: true,
            crossoverRendering: true,
            nativeMacMetalHud: false,
          },
          modeNotes: {},
        } as any);

        let savedModalConfig: GameLaunchConfig | undefined;
        const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
          isOpen: true,
          game: synthGamePe32,
          initialPlatformId: 'gog',
          onClose: () => {},
          onSaved: (cfg: GameLaunchConfig) => {
            savedModalConfig = cfg;
          },
        });

        // Render macOS PE32 GameLaunchConfigModal (second render flushes initial useEffect config load)
        renderer.render();
        let tree = renderer.render();

        // Verify 0 WCAG 2.2 AA violations on full GameLaunchConfigModal (macOS PE32 bottled)
        expect(auditWcag22AA(tree)).toEqual([]);

        // Verify single-bundle CrossOver hides D3DMetal version selector & shows 32-bit DLSS disabled reason
        const fullHtml = JSON.stringify(tree);
        expect(fullHtml).toContain(
          'Requires a 64-bit Windows executable (DLSS is not supported on 32-bit x86 games).'
        );
        expect(fullHtml).not.toContain('D3DMetal 4.0');

        // Switch backend select to 'auto' so both Metal HUD and DXVK HUD switches are rendered & persisted
        const backendSelect = findVNodes(
          tree,
          (el) => el.type === 'select' && el.props?.value === 'dxmt'
        )[0];
        expect(backendSelect).toBeTruthy();
        backendSelect.props.onChange({ target: { value: 'auto' } });

        tree = renderer.render();
        expect(auditWcag22AA(tree)).toEqual([]);

        // Uncheck both HUD switches ('Apple Metal HUD' and 'DXVK / DXMT HUD')
        const metalToggle = findVNodes(
          tree,
          (el) => el.type === 'button' && el.props?.['data-testid'] === 'toggle-metal-hud'
        )[0];
        expect(metalToggle).toBeTruthy();
        expect(metalToggle.props.role).toBe('switch');
        expect(metalToggle.props['aria-checked']).toBe(true);
        metalToggle.props.onClick();

        tree = renderer.render();

        const dxvkToggle = findVNodes(
          tree,
          (el) => el.type === 'button' && el.props?.['data-testid'] === 'toggle-dxvk-hud'
        )[0];
        expect(dxvkToggle).toBeTruthy();
        expect(dxvkToggle.props.role).toBe('switch');
        expect(dxvkToggle.props['aria-checked']).toBe(true);
        dxvkToggle.props.onClick();

        tree = renderer.render();

        const saveBtn = findVNodes(
          tree,
          (el) => el.type === 'button' && extractVNodeText(el).includes('Save Configuration')
        )[0];
        expect(saveBtn).toBeTruthy();
        await saveBtn.props.onClick();

        expect(savedModalConfig).toBeTruthy();
        const reloaded = getLaunchConfigFromStorage('syn-modal-pe32', 'gog');
        expect(reloaded?.metalHud).toBe(false);
        expect(reloaded?.dxvkHud).toBe(false);
        expect(reloaded?.metalfxSpatialUpscaleFactor).toBe(1.5);
        expect(reloaded?.preferredMaxFrameRate).toBe(90);
        expect(reloaded?.emulateModeset).toBe(true);
        expect(reloaded?.forceLargeAddressAware).toBe(true);
        // Pass-through fields preserved untouched!
        expect(reloaded?.virtualDesktop).toBe(true);
        expect(reloaded?.audioBufferClamp).toBe(true);
        expect(reloaded?.advertiseAvx).toBe(false);
        renderer.unmount();

        // Also render CompatibilityLayerSectionBase for 64-bit PE32+ & GameLaunchConfigModal on Windows native (win32) -> 0 WCAG 2.2 AA violations
        const pe64SectionRenderer = createDomain12DeepRenderer(CompatibilityLayerSectionBase, {
          idPrefix: 'wcag-pe64',
          isWindowsHost: false,
          activeDisplayMethod: 'compatibility_layer',
          preview: {
            effectiveMode: 'compatibility_layer',
            defaultLaunchMethod: 'compatibility_layer',
            availableModes: ['auto', 'compatibility_layer', 'direct'],
            detectedBuildType: 'windows_exe_on_mac',
            peArchitecture: 'x64',
            is32BitExecutable: false,
            executableArchitecture: 'x64',
            isInstalled: true,
            visibleSections: {
              compatibilityLayer: true,
              crossoverRendering: true,
              nativeMacMetalHud: false,
            },
            modeNotes: {},
          },
          compatibilityLayer: 'crossover',
          detectedLayers: [singleD3dLayer],
          runnerUpdates: {},
          selectedRunnerDescriptor: {
            type: 'crossover',
            label: 'CrossOver',
            shortLabel: 'CrossOver',
            badge: 'Commercial',
            summary: 'Commercial Wine/D3DMetal/DXMT translation layer.',
            installGuide: 'Install CrossOver.',
            brewFormulaOrCask: 'crossover',
            brewIsCask: true,
            officialUrl: 'https://www.codeweavers.com/crossover',
          },
          activeLayer: singleD3dLayer,
          activeUpdateInfo: undefined,
          activeInstalledVer: '26.3.0',
          activeSecondaryBuildText: '',
          availableBottles: ['SynthBottle'],
          wineBottleName: 'SynthBottle',
          winePrefixPath: '',
          resolvedBottleFolderPath: '/tmp/synth-cx/Bottles/SynthBottle',
          showCrossoverRenderingControls: true,
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverD3DMetalVersion: 'auto',
          showD3DMetalVersionSelector: false,
          primaryD3DVer: '3.0',
          fallbackD3DVer: '3.0',
          crossoverHighResolutionMode: undefined,
          crossoverDlss: true,
          isDlssSupportedBackend: true,
          dlssUnavailableReason: undefined,
          preferredMaxFrameRate: 120,
          metalfxSpatialUpscaleFactor: undefined,
          emulateModeset: false,
          forceLargeAddressAware: undefined,
          peArchitecture: 'x64',
          wineMsync: true,
          wineEsync: false,
          showMetalHudToggle: true,
          metalHud: false,
          isDxvkHudSupported: false,
          dxvkHud: false,
          isRescanningRunners: false,
          isCheckingUpdates: false,
          isUpdatingRunner: false,
          isInstallingRunner: false,
          runnerActionFeedback: null,
          runnerUpdateFeedback: null,
          onSelectCompatibilityLayer: () => {},
          onRescanLayers: () => {},
          onCheckRunnerUpdates: () => {},
          onUpdateRunner: () => {},
          onInstallRunnerViaBrew: () => {},
          onDownloadRunner: () => {},
          onChangeBottleName: () => {},
          onChangeWinePrefixPath: () => {},
          onBrowseWinePrefix: () => {},
          onOpenBottleFolder: () => {},
          onChangeGraphicsBackend: () => {},
          onChangeD3DMetalVersion: () => {},
          onChangeHighResolutionMode: () => {},
          onToggleCrossoverDlss: () => {},
          onChangePreferredMaxFrameRate: () => {},
          onChangeMetalfxSpatialUpscaleFactor: () => {},
          onChangeEmulateModeset: () => {},
          onToggleForceLargeAddressAware: () => {},
          onToggleWineMsync: () => {},
          onToggleWineEsync: () => {},
          onToggleMetalHud: () => {},
          onToggleDxvkHud: () => {},
        } as any);
        const pe64SectionTree = pe64SectionRenderer.render();
        expect(auditWcag22AA(pe64SectionTree)).toEqual([]);
        pe64SectionRenderer.unmount();

        // Windows x64 native GameLaunchConfigModal render -> 0 WCAG 2.2 AA violations & hides macOS CompatibilityLayerSection
        (globalThis as any).window = {
          localStorage: mockStorage,
          electronAPI: { platform: 'win32' },
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true,
        };
        vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(true);
        vi.spyOn(launcherService, 'resolveEffectiveLaunchModePreview').mockReturnValue({
          effectiveMode: 'direct',
          defaultLaunchMethod: 'direct',
          availableModes: ['auto', 'direct', 'storefront_uri'],
          detectedBuildType: 'windows_native',
          peArchitecture: 'x64',
          isInstalled: true,
          installPath: 'C:\\Games\\Synthetic Studio RPG 64',
          executablePath: 'C:\\Games\\Synthetic Studio RPG 64\\SynthStudio64.exe',
          visibleSections: {
            compatibilityLayer: false,
            crossoverRendering: false,
            nativeMacMetalHud: false,
          },
          modeNotes: {},
        } as any);

        const winRenderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
          isOpen: true,
          game: {
            id: 'syn-modal-win64',
            title: 'Synthetic Studio RPG 64',
            sortTitle: 'Synthetic Studio RPG 64',
            headerImage: '',
            developers: ['Synthetic Studio'],
            publishers: ['Synthetic Publisher'],
            genres: ['RPG'],
            tags: [],
            platforms: [
              {
                platformId: 'gog',
                platformGameId: '19990202',
                installed: true,
                installPath: 'C:\\Games\\Synthetic Studio RPG 64',
                executablePath: 'C:\\Games\\Synthetic Studio RPG 64\\SynthStudio64.exe',
              },
            ],
          },
          initialPlatformId: 'gog',
          onClose: () => {},
        });
        const winTree = winRenderer.render();
        expect(auditWcag22AA(winTree)).toEqual([]);
        expect(JSON.stringify(winTree)).not.toContain('Metal HUD');
        winRenderer.unmount();
      } finally {
        (globalThis as any).window = prevWindow;
        (globalThis as any).localStorage = prevLocalStorage;
        (globalThis as any).CustomEvent = prevCustomEvent;
      }
    });
  });
});
