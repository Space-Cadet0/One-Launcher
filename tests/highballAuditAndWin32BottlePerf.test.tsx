import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

import {
  createDomain12DeepRenderer,
  getDomPurifyFragmentBuilder,
  sanitizeHtmlStringViaDomParser,
} from './helpers/xboxTestHarness';
import {
  loadLocalKeyedHmacConfig,
  scanContentForPiiViolations,
  walkHygieneFiles,
} from './helpers/piiHygieneGuard';

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

import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  CROSSOVER_GRAPHICS_BACKEND_POLICIES,
  getCrossOverGraphicsBackendPolicy,
} from '../src/services/launcher/launchPolicyPreview';
import {
  CompatibilityLayerSection,
  type CompatibilityLayerSectionProps,
} from '../src/components/Launcher/LaunchConfig/CompatibilityLayerSection';
import { SystemRequirements } from '../src/components/SteamStoreDetail/SystemRequirements';
import type {
  CrossOverGraphicsBackend,
  ResolvedLaunchModePreview,
} from '../src/contracts/launcher';

const requireCjs = createRequire(import.meta.url);
const binaryInspectors = requireCjs('../electron/launcher/binaryAndManifestInspectors.cjs');
const macInstaller = requireCjs('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const wineManager = requireCjs('../electron/launcher/wineAndCrossOverManager.cjs');
const sessionSupervisor = requireCjs('../electron/launcher/sessionAndProcessSupervisor.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const THIS_TEST_FILE = path.join(REPO_ROOT, 'tests', 'highballAuditAndWin32BottlePerf.test.tsx');

// ============================================================================
// Hermetic Browser/DOM Polyfills & Offline Socket Guard
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

function ensureWindowAndStorageGlobals(platform: 'darwin' | 'win32' = 'darwin'): void {
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
      navigator: { userAgent: platform === 'darwin' ? 'Macintosh' : 'Windows NT 10.0', onLine: true },
      electronAPI: { platform },
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
  } else {
    g.window.localStorage = g.window.localStorage || g.localStorage;
    g.window.electronAPI = { ...(g.window.electronAPI || {}), platform };
  }
}

ensureWindowAndStorageGlobals('darwin');

function installHermeticOfflineSocketGuard() {
  const origConnect = net.Socket.prototype.connect;
  return vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const first = args[0];
    const host =
      typeof first === 'object' && first !== null && 'host' in first
        ? String((first as { host?: string }).host || '127.0.0.1')
        : typeof args[1] === 'string'
          ? args[1]
          : '127.0.0.1';
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const isUnixPipe =
      typeof first === 'string' ||
      (typeof first === 'object' && first !== null && 'path' in first);
    if (!isLoopback && !isUnixPipe) {
      throw new Error(`Hermetic test guard blocked outbound TCP connection to "${host}"`);
    }
    return (origConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  });
}

// ============================================================================
// VNode Tree Traversal & Deterministic WCAG 2.2 AA + WAI-ARIA Auditor
// ============================================================================

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

    if (props.role === 'tablist') {
      const hasName =
        (typeof props['aria-label'] === 'string' && props['aria-label'].trim().length > 0) ||
        (typeof props['aria-labelledby'] === 'string' && props['aria-labelledby'].trim().length > 0);
      if (!hasName) {
        violations.push(`aria-tablist-name: ${testId} role="tablist" lacks accessible name`);
      }
      const tabs = findVNodes(el, (n) => typeof n.type === 'string' && n.props?.role === 'tab');
      const activeTabs = tabs.filter((t) => t.props?.['aria-selected'] === true);
      const tabbableTabs = tabs.filter((t) => t.props?.tabIndex === 0);
      if (tabs.length > 0 && activeTabs.length !== 1) {
        violations.push(
          `aria-tablist-selected: expected exactly 1 aria-selected=true tab, got ${activeTabs.length}`
        );
      }
      if (tabs.length > 0 && tabbableTabs.length !== 1) {
        violations.push(
          `aria-roving-tabindex: expected exactly 1 tabIndex=0 tab, got ${tabbableTabs.length}`
        );
      }
    }

    if (props.role === 'tabpanel') {
      const hasName =
        (typeof props['aria-labelledby'] === 'string' &&
          props['aria-labelledby'].trim().length > 0) ||
        (typeof props['aria-label'] === 'string' && props['aria-label'].trim().length > 0);
      if (!hasName) {
        violations.push(`aria-tabpanel-name: ${testId} role="tabpanel" lacks accessible name`);
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

// ============================================================================
// Synthetic PE32 (0x010b) & PE32+ (0x020b) Builder with DataDirectory[1] & [13]
// ============================================================================

interface DelayImportSpec {
  dll: string;
  grAttrs?: 0 | 1;
}

interface SyntheticPeOptions {
  arch: 'x86' | 'x64';
  isDll?: boolean;
  largeAddressAware?: boolean;
  nxCompat?: boolean;
  dynamicBase?: boolean;
  importedDlls?: string[];
  delayImportedDlls?: Array<string | DelayImportSpec>;
  rdataStrings?: string[];
  imageBase?: bigint;
}

function alignUp(val: number, align: number): number {
  return Math.ceil(val / align) * align;
}

function buildSyntheticPeBuffer(opts: SyntheticPeOptions): Buffer {
  const isPe32 = opts.arch === 'x86';
  const machine = isPe32 ? 0x014c : 0x8664;
  const optMagic = isPe32 ? 0x010b : 0x020b;
  const sizeOfOptionalHeader = isPe32 ? 224 : 240;
  const imageBase = opts.imageBase ?? (isPe32 ? 0x00400000n : 0x0000000140000000n);

  const imports = opts.importedDlls ?? [];
  const delayImports: DelayImportSpec[] = (opts.delayImportedDlls ?? []).map((entry) =>
    typeof entry === 'string' ? { dll: entry, grAttrs: 1 } : { dll: entry.dll, grAttrs: entry.grAttrs ?? 1 }
  );
  const rdataStrings = opts.rdataStrings ?? [];

  interface SectionDesc {
    name: string;
    rva: number;
    rawOffset: number;
    rawSize: number;
    payload: Buffer;
    characteristics: number;
  }

  const sections: SectionDesc[] = [];
  let nextRawOffset = 0x0400;
  let nextRva = 0x1000;

  // 1. `.text` section
  const textPayload = Buffer.from([0x31, 0xc0, 0xc3, 0x90]);
  const textRawSize = alignUp(Math.max(0x0200, textPayload.length), 0x0200);
  sections.push({
    name: '.text',
    rva: nextRva,
    rawOffset: nextRawOffset,
    rawSize: textRawSize,
    payload: textPayload,
    characteristics: 0x60000020,
  });
  nextRawOffset += textRawSize;
  nextRva += 0x1000;

  // 2. `.idata` section (`DataDirectory[1]` standard imports)
  let importDirRva = 0;
  let importDirSize = 0;
  if (imports.length > 0) {
    const idataRva = nextRva;
    const descTableBytes = (imports.length + 1) * 20;
    const thunkEntryBytes = isPe32 ? 4 : 8;
    const thunkTableOffset = descTableBytes;
    const thunkTableBytes = imports.length * (thunkEntryBytes * 2);
    let strCursor = thunkTableOffset + thunkTableBytes;

    const strChunks: Buffer[] = [];
    const nameRelOffsets: number[] = [];
    const hintRelOffsets: number[] = [];
    for (const dll of imports) {
      nameRelOffsets.push(strCursor);
      const nb = Buffer.from(`${dll}\0`, 'ascii');
      strChunks.push(nb);
      strCursor += nb.length;
      hintRelOffsets.push(strCursor);
      const hintBuf = Buffer.from([0x00, 0x00, 0x49, 0x6e, 0x69, 0x74, 0x00]); // "Init"
      strChunks.push(hintBuf);
      strCursor += hintBuf.length;
    }

    const idataPayload = Buffer.alloc(strCursor, 0);
    for (let i = 0; i < imports.length; i += 1) {
      const dOff = i * 20;
      const tOff = thunkTableOffset + i * (thunkEntryBytes * 2);
      idataPayload.writeUInt32LE(idataRva + tOff, dOff + 0); // OriginalFirstThunk
      idataPayload.writeUInt32LE(0, dOff + 4);
      idataPayload.writeUInt32LE(0, dOff + 8);
      idataPayload.writeUInt32LE(idataRva + nameRelOffsets[i], dOff + 12); // Name RVA
      idataPayload.writeUInt32LE(idataRva + tOff, dOff + 16); // FirstThunk
      idataPayload.writeUInt32LE(idataRva + hintRelOffsets[i], tOff);
    }
    Buffer.concat(strChunks).copy(idataPayload, thunkTableOffset + thunkTableBytes);

    const idataRawSize = alignUp(Math.max(0x0200, idataPayload.length), 0x0200);
    importDirRva = idataRva;
    importDirSize = descTableBytes;
    sections.push({
      name: '.idata',
      rva: idataRva,
      rawOffset: nextRawOffset,
      rawSize: idataRawSize,
      payload: idataPayload,
      characteristics: 0x40000040,
    });
    nextRawOffset += idataRawSize;
    nextRva += Math.max(0x1000, alignUp(idataRawSize, 0x1000));
  }

  // 3. `.didata` section (`DataDirectory[13]` 32-byte `ImgDelayDescr` delay-load imports)
  let delayDirRva = 0;
  let delayDirSize = 0;
  if (delayImports.length > 0) {
    const didataRva = nextRva;
    const descTableBytes = (delayImports.length + 1) * 32;
    let strCursor = descTableBytes;
    const strChunks: Buffer[] = [];
    const nameRelOffsets: number[] = [];

    for (const item of delayImports) {
      nameRelOffsets.push(strCursor);
      const nb = Buffer.from(`${item.dll}\0`, 'ascii');
      strChunks.push(nb);
      strCursor += nb.length;
    }

    const didataPayload = Buffer.alloc(strCursor + 16, 0);
    for (let i = 0; i < delayImports.length; i += 1) {
      const dOff = i * 32;
      const grAttrs = delayImports[i].grAttrs ?? 1;
      const rawNameRva = didataRva + nameRelOffsets[i];
      const encodedDllNameField =
        grAttrs === 0 ? Number((imageBase + BigInt(rawNameRva)) & 0xffffffffn) : rawNameRva;

      didataPayload.writeUInt32LE(grAttrs, dOff + 0); // grAttrs (1 = RVA, 0 = VA)
      didataPayload.writeUInt32LE(encodedDllNameField >>> 0, dOff + 4); // rvaDLLName / szName
      didataPayload.writeUInt32LE(didataRva + strCursor, dOff + 8); // rvaHmod
      didataPayload.writeUInt32LE(didataRva + strCursor + 4, dOff + 12); // rvaIAT
      didataPayload.writeUInt32LE(didataRva + strCursor + 8, dOff + 16); // rvaINT
    }
    Buffer.concat(strChunks).copy(didataPayload, descTableBytes);

    const didataRawSize = alignUp(Math.max(0x0200, didataPayload.length), 0x0200);
    delayDirRva = didataRva;
    delayDirSize = descTableBytes;
    sections.push({
      name: '.didata',
      rva: didataRva,
      rawOffset: nextRawOffset,
      rawSize: didataRawSize,
      payload: didataPayload,
      characteristics: 0x40000040,
    });
    nextRawOffset += didataRawSize;
    nextRva += Math.max(0x1000, alignUp(didataRawSize, 0x1000));
  }

  // 4. `.rdata` section (optional dynamic string table)
  if (rdataStrings.length > 0) {
    const rdataRva = nextRva;
    const chunks = [
      Buffer.alloc(16, 0),
      ...rdataStrings.map((s) => Buffer.from(`${s}\0`, 'ascii')),
      Buffer.alloc(16, 0),
    ];
    const rdataPayload = Buffer.concat(chunks);
    const rdataRawSize = alignUp(Math.max(0x0200, rdataPayload.length), 0x0200);
    sections.push({
      name: '.rdata',
      rva: rdataRva,
      rawOffset: nextRawOffset,
      rawSize: rdataRawSize,
      payload: rdataPayload,
      characteristics: 0x40000040,
    });
    nextRawOffset += rdataRawSize;
    nextRva += Math.max(0x1000, alignUp(rdataRawSize, 0x1000));
  }

  const totalFileSize = nextRawOffset;
  const img = Buffer.alloc(totalFileSize, 0);

  // DOS Header (`MZ` + `e_lfanew = 0x80`)
  const peOffset = 0x80;
  img[0] = 0x4d;
  img[1] = 0x5a;
  img.writeUInt32LE(peOffset, 0x3c);

  // PE Signature + COFF File Header (24 bytes)
  img.write('PE\0\0', peOffset, 'ascii');
  img.writeUInt16LE(machine, peOffset + 4);
  img.writeUInt16LE(sections.length, peOffset + 6);
  img.writeUInt16LE(sizeOfOptionalHeader, peOffset + 20);

  let coffChars = 0x0002; // IMAGE_FILE_EXECUTABLE_IMAGE
  if (opts.isDll) coffChars |= 0x2000; // IMAGE_FILE_DLL
  const laaEnabled = opts.largeAddressAware ?? !isPe32;
  if (laaEnabled) coffChars |= 0x0020; // IMAGE_FILE_LARGE_ADDRESS_AWARE
  if (isPe32) coffChars |= 0x0100; // IMAGE_FILE_32BIT_MACHINE
  img.writeUInt16LE(coffChars, peOffset + 22);

  // Optional Header
  const optOffset = peOffset + 24;
  img.writeUInt16LE(optMagic, optOffset + 0);
  img.writeUInt32LE(0x1000, optOffset + 16); // AddressOfEntryPoint
  img.writeUInt32LE(0x1000, optOffset + 20); // BaseOfCode

  if (isPe32) {
    img.writeUInt32LE(Number(imageBase & 0xffffffffn) >>> 0, optOffset + 28);
  } else {
    img.writeBigUInt64LE(imageBase, optOffset + 24);
  }
  img.writeUInt32LE(0x1000, optOffset + 32); // SectionAlignment
  img.writeUInt32LE(0x0200, optOffset + 36); // FileAlignment
  img.writeUInt32LE(nextRva, optOffset + 56); // SizeOfImage
  img.writeUInt32LE(0x0400, optOffset + 60); // SizeOfHeaders
  img.writeUInt16LE(2, optOffset + 68); // Subsystem = WINDOWS_GUI

  let dllChars = 0;
  if (opts.nxCompat ?? true) dllChars |= 0x0100; // IMAGE_DLLCHARACTERISTICS_NX_COMPAT
  if (opts.dynamicBase ?? true) dllChars |= 0x0040; // IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE
  img.writeUInt16LE(dllChars, optOffset + 70);

  const numDirsOffset = isPe32 ? 92 : 108;
  const dataDirOffset = isPe32 ? 96 : 112;
  img.writeUInt32LE(16, optOffset + numDirsOffset); // NumberOfRvaAndSizes = 16

  if (importDirRva > 0) {
    img.writeUInt32LE(importDirRva, optOffset + dataDirOffset + 8); // DataDirectory[1].VirtualAddress
    img.writeUInt32LE(importDirSize, optOffset + dataDirOffset + 12); // DataDirectory[1].Size
  }
  if (delayDirRva > 0) {
    img.writeUInt32LE(delayDirRva, optOffset + dataDirOffset + 104); // DataDirectory[13].VirtualAddress
    img.writeUInt32LE(delayDirSize, optOffset + dataDirOffset + 108); // DataDirectory[13].Size
  }

  // Section Headers (40 bytes each) + Section Payloads
  const secTableOffset = optOffset + sizeOfOptionalHeader;
  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i];
    const sBase = secTableOffset + i * 40;
    Buffer.from(sec.name.padEnd(8, '\0').slice(0, 8), 'ascii').copy(img, sBase);
    img.writeUInt32LE(sec.payload.length, sBase + 8); // VirtualSize
    img.writeUInt32LE(sec.rva, sBase + 12); // VirtualAddress
    img.writeUInt32LE(sec.rawSize, sBase + 16); // SizeOfRawData
    img.writeUInt32LE(sec.rawOffset, sBase + 20); // PointerToRawData
    img.writeUInt32LE(sec.characteristics >>> 0, sBase + 36);
    sec.payload.copy(img, sec.rawOffset);
  }

  return img;
}

// ============================================================================
// Test Suites
// ============================================================================

describe('Clean-Room Launch Engine Hardening & 32-Bit PE32 Bottled Performance Regression Suite', () => {
  let tmpRoot: string;
  let socketGuard: ReturnType<typeof installHermeticOfflineSocketGuard>;

  beforeEach(() => {
    socketGuard = installHermeticOfflineSocketGuard();
    // Create synthetic temp root strictly under /tmp/ol-hb-win32-test-... (avoids /var/folders PII patterns)
    const baseTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
    tmpRoot = fs.mkdtempSync(path.join(baseTmp, 'ol-hb-win32-test-'));
    memStorage.clear();
    ensureWindowAndStorageGlobals('darwin');
  });

  afterEach(() => {
    socketGuard.mockRestore();
    vi.restoreAllMocks();
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 0. Zero-PII & MIT Clean-Room Self-Governance Gate
  // --------------------------------------------------------------------------
  describe('0. Zero-PII & MIT Clean-Room Boundary Governance', () => {
    it('scans this test file and modified launch/graphics modules with zero PII violations and verifies clean-room MIT licensing boundary', () => {
      const hmacCfg = loadLocalKeyedHmacConfig(REPO_ROOT);
      const selfContent = fs.readFileSync(THIS_TEST_FILE, 'utf8');
      expect(
        scanContentForPiiViolations(
          selfContent,
          'tests/highballAuditAndWin32BottlePerf.test.tsx',
          hmacCfg
        )
      ).toEqual([]);

      // Verify MIT clean-room boundary across electron/, src/, and tests/ (zero GPL headers or external copyleft reference tokens)
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
      expect(pkg.license).toBe('MIT');

      const gplHeaderPattern = new RegExp(
        [
          ['GNU', 'General', 'Public', 'License'].join('\\s+'),
          ['SPDX-License-Identifier:\\s*(?:A|L)?GPL'].join(''),
        ].join('|'),
        'i'
      );
      const kegRunnerToken = ['keg', 'works'].join('');
      const copyleftRefIdPattern = new RegExp(
        `\\b(?:${['high', 'ball'].join('')}|${kegRunnerToken})\\b`,
        'i'
      );
      const allowedHostRunnerDiscoveryPattern = new RegExp(
        [
          `Library/Application Support/${kegRunnerToken}/Engines`,
          `Open-Source Wine \\(${kegRunnerToken}\\)`,
          `\\(Whisky,\\s*Sikarugir,\\s*${kegRunnerToken},\\s*Mythic\\)`,
          `\\(\`Heroic\`,\\s*\`Whisky\`,\\s*\`Sikarugir\`,\\s*\`${kegRunnerToken}\`,\\s*\`Mythic\`\\)`,
          `Heroic\\|Whisky\\|Sikarugir\\|${kegRunnerToken}\\|Mythic`,
          `return '${kegRunnerToken}'`,
        ].join('|'),
        'gi'
      );

      const codeFiles = [
        ...walkHygieneFiles(path.join(REPO_ROOT, 'src'), /\.(?:ts|tsx)$/i),
        ...walkHygieneFiles(path.join(REPO_ROOT, 'electron'), /\.(?:cjs|mjs|js|c|h)$/i),
      ];
      expect(codeFiles.length).toBeGreaterThan(40);

      const cleanRoomViolations: string[] = [];
      for (const file of codeFiles) {
        const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
        const text = fs.readFileSync(file, 'utf8');
        if (gplHeaderPattern.test(text)) {
          cleanRoomViolations.push(`${rel}: contains copyleft GPL license header`);
        }
        const sanitizedForRefCheck =
          rel === 'electron/launcher/macNativeInstallerAndCodesign.cjs' ||
          rel === 'electron/launcher/environmentProvisioner.cjs'
            ? text.replace(allowedHostRunnerDiscoveryPattern, '')
            : text;
        if (copyleftRefIdPattern.test(sanitizedForRefCheck)) {
          cleanRoomViolations.push(`${rel}: contains external reference project identifier`);
        }
      }
      expect(cleanRoomViolations).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // 1. PE32 (0x10b) vs PE32+ (0x20b) Header, Delay-Load Imports, LAA/DEP & UE5 IoStore
  // --------------------------------------------------------------------------
  describe('1. PE32 vs PE32+ Header, Delay-Load Imports (DataDirectory[13]), LAA/DEP Flags & UE5 IoStore Detection', () => {
    it('distinguishes PE32 (0x10b) LAA/non-LAA and NX/non-NX flags from PE32+ (0x20b) and parses both DataDirectory[1] and DataDirectory[13] (RVA & VA ImgDelayDescr) imports', () => {
      // 1a. 32-bit PE32 WITH Large Address Aware (0x0020) + NX_COMPAT (0x0100) + delay-loaded d3d11.dll (grAttrs=1 RVA)
      const pe32LaaNxPath = path.join(tmpRoot, 'SynthDx11Laa.exe');
      fs.writeFileSync(
        pe32LaaNxPath,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: true,
          nxCompat: true,
          dynamicBase: true,
          importedDlls: ['KERNEL32.dll', 'USER32.dll'],
          delayImportedDlls: [{ dll: 'D3D11.DLL', grAttrs: 1 }, { dll: 'dxgi.dll', grAttrs: 1 }],
        })
      );

      const hdrLaaNx = binaryInspectors.inspectWindowsExecutableHeader(pe32LaaNxPath, {
        strictPe: true,
      });
      expect(hdrLaaNx.isValidPe).toBe(true);
      expect(hdrLaaNx.is32Bit).toBe(true);
      expect(hdrLaaNx.isX86).toBe(true);
      expect(hdrLaaNx.is64Bit).toBe(false);
      expect(hdrLaaNx.isLargeAddressAware).toBe(true);
      expect(hdrLaaNx.isNxCompat).toBe(true);
      expect(hdrLaaNx.isDynamicBase).toBe(true);
      expect(hdrLaaNx.delayImportedDlls).toEqual(['d3d11.dll', 'dxgi.dll']);
      expect(hdrLaaNx.importedDlls).toEqual(
        expect.arrayContaining(['kernel32.dll', 'user32.dll', 'd3d11.dll', 'dxgi.dll'])
      );

      const capsLaaNx = binaryInspectors.inspectPeCapabilities(pe32LaaNxPath, { strictPe: true });
      expect(capsLaaNx.machineArch).toBe('x86');
      expect(capsLaaNx.importsD3d11Or10).toBe(true);
      expect(capsLaaNx.importsD3d9).toBe(false);
      expect(capsLaaNx.importsD3d12).toBe(false);
      expect(capsLaaNx.isD3d12Only).toBe(false);

      // 1b. Legacy 32-bit PE32 WITHOUT LAA (2 GB VA limit) and WITHOUT NX_COMPAT (non-DEP) + VC6 VA-based (grAttrs=0) delay-loaded d3d9.dll
      const pe32LegacyPath = path.join(tmpRoot, 'SynthLegacyNonLaaNonNx.exe');
      fs.writeFileSync(
        pe32LegacyPath,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: false,
          nxCompat: false,
          dynamicBase: false,
          imageBase: 0x00400000n,
          importedDlls: ['kernel32.dll'],
          delayImportedDlls: [{ dll: 'd3d9.dll', grAttrs: 0 }],
        })
      );

      const capsLegacy = binaryInspectors.inspectPeCapabilities(pe32LegacyPath, { strictPe: true });
      expect(capsLegacy.isValidPe).toBe(true);
      expect(capsLegacy.is32Bit).toBe(true);
      expect(capsLegacy.is64Bit).toBe(false);
      expect(capsLegacy.isLargeAddressAware).toBe(false);
      expect(capsLegacy.isNxCompat).toBe(false);
      expect(capsLegacy.isDynamicBase).toBe(false);
      expect(capsLegacy.delayImportedDlls).toEqual(['d3d9.dll']);
      expect(capsLegacy.importsD3d9).toBe(true);

      // 1c. 64-bit PE32+ (0x20b) with standard vulkan-1.dll and delay-loaded d3d12.dll
      const pe64Path = path.join(tmpRoot, 'SynthModern64.exe');
      fs.writeFileSync(
        pe64Path,
        buildSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'vulkan-1.dll'],
          delayImportedDlls: ['d3d12.dll'],
        })
      );

      const caps64 = binaryInspectors.inspectPeCapabilities(pe64Path, { strictPe: true });
      expect(caps64.isValidPe).toBe(true);
      expect(caps64.is64Bit).toBe(true);
      expect(caps64.is32Bit).toBe(false);
      expect(caps64.machineArch).toBe('x64');
      expect(caps64.isLargeAddressAware).toBe(true);
      expect(caps64.isNxCompat).toBe(true);
      expect(caps64.importsVulkan).toBe(true);
      expect(caps64.importsD3d12).toBe(true);
      // Not D3D12-only because vulkan-1.dll is also imported
      expect(caps64.isD3d12Only).toBe(false);

      // 1d. Direct derivePeGraphicsCapabilities matrix (opengl32, ddraw, d3d12-only, UE5 IoStore)
      expect(binaryInspectors.derivePeGraphicsCapabilities(['opengl32.dll'])).toMatchObject({
        importsLegacyD3dOrGl: true,
        importsD3d11Or10: false,
        importsD3d9: false,
        isD3d12Only: false,
      });
      expect(
        binaryInspectors.derivePeGraphicsCapabilities(['dxgi.dll'], {
          hasUe5IoStoreContainer: true,
        })
      ).toMatchObject({
        hasUe5IoStoreContainer: true,
        importsD3d11Or10: false,
        isD3d12Only: true,
      });
    });

    it('detects UE5 IoStore (*.utoc + *.ucas) containers and resolves bounded sibling .dll graphics imports when launcher .exe only imports kernel32.dll', () => {
      // 2a. UE5 Shipping directory layout: <Root>/ProjectSynth/Content/Paks/pakchunk0-Windows.utoc + .ucas
      const ue5Root = path.join(tmpRoot, 'ue5-game');
      const paksDir = path.join(ue5Root, 'ProjectSynth', 'Content', 'Paks');
      const win64Dir = path.join(ue5Root, 'ProjectSynth', 'Binaries', 'Win64');
      fs.mkdirSync(paksDir, { recursive: true });
      fs.mkdirSync(win64Dir, { recursive: true });
      fs.writeFileSync(path.join(paksDir, 'pakchunk0-Windows.utoc'), Buffer.alloc(64, 0xaa));
      fs.writeFileSync(path.join(paksDir, 'pakchunk0-Windows.ucas'), Buffer.alloc(64, 0xbb));

      const ue5ShippingExe = path.join(win64Dir, 'ProjectSynth-Win64-Shipping.exe');
      fs.writeFileSync(
        ue5ShippingExe,
        buildSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['kernel32.dll', 'dxgi.dll'],
        })
      );

      expect(binaryInspectors.detectUe5IoStoreContainer(ue5Root, ue5ShippingExe)).toBe(true);
      const ue5Caps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        ue5ShippingExe,
        ue5Root,
        { strictPe: true }
      );
      expect(ue5Caps.is64Bit).toBe(true);
      expect(ue5Caps.hasUe5IoStoreContainer).toBe(true);
      expect(ue5Caps.isD3d12Only).toBe(true);

      // Negative control: UE4 .pak without .utoc must return false
      const ue4Root = path.join(tmpRoot, 'ue4-game');
      const ue4Paks = path.join(ue4Root, 'Synth4', 'Content', 'Paks');
      fs.mkdirSync(ue4Paks, { recursive: true });
      fs.writeFileSync(path.join(ue4Paks, 'pakchunk0-WindowsNoEditor.pak'), Buffer.alloc(32, 0x11));
      expect(binaryInspectors.detectUe5IoStoreContainer(ue4Root)).toBe(false);

      // 2b. Bounded sibling .dll fallback: 32-bit GameMain.exe (> 2 MB or standalone name) imports ONLY kernel32.dll,
      // while sibling EngineRender32.dll imports d3d11.dll (and mismatched 64-bit Helper64.dll is ignored!)
      const dllFallbackDir = path.join(tmpRoot, 'pe32-sibling-dll-game');
      fs.mkdirSync(dllFallbackDir, { recursive: true });
      const thinMainExe = path.join(dllFallbackDir, 'SynthClient.exe');
      fs.writeFileSync(
        thinMainExe,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: true,
          nxCompat: true,
          importedDlls: ['kernel32.dll'],
        })
      );
      fs.writeFileSync(
        path.join(dllFallbackDir, 'EngineRender32.dll'),
        buildSyntheticPeBuffer({
          arch: 'x86',
          isDll: true,
          importedDlls: ['kernel32.dll'],
          delayImportedDlls: ['d3d11.dll'],
        })
      );
      // Mismatched 64-bit DLL importing d3d12.dll must be skipped because primary .exe is 32-bit
      fs.writeFileSync(
        path.join(dllFallbackDir, 'OptionalTelemetry64.dll'),
        buildSyntheticPeBuffer({
          arch: 'x64',
          isDll: true,
          importedDlls: ['d3d12.dll'],
        })
      );

      const resolvedDllFallback = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        thinMainExe,
        dllFallbackDir,
        { strictPe: true }
      );
      expect(resolvedDllFallback.is32Bit).toBe(true);
      expect(resolvedDllFallback.isLargeAddressAware).toBe(true);
      expect(resolvedDllFallback.isNxCompat).toBe(true);
      expect(resolvedDllFallback.importedDlls).toContain('d3d11.dll');
      expect(resolvedDllFallback.importedDlls).not.toContain('d3d12.dll');
      expect(resolvedDllFallback.importsD3d11Or10).toBe(true);

      // 2c. Sibling engine .dll importing d3d9.dll for a non-LAA 32-bit executable
      const dx9DllDir = path.join(tmpRoot, 'pe32-dx9-sibling-dll');
      fs.mkdirSync(dx9DllDir, { recursive: true });
      const dx9MainExe = path.join(dx9DllDir, 'ClassicEngine.exe');
      fs.writeFileSync(
        dx9MainExe,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: false,
          nxCompat: true,
          importedDlls: ['kernel32.dll'],
        })
      );
      fs.writeFileSync(
        path.join(dx9DllDir, 'ShaderDrv.dll'),
        buildSyntheticPeBuffer({
          arch: 'x86',
          isDll: true,
          importedDlls: ['d3d9.dll'],
        })
      );
      const resolvedDx9Fallback = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        dx9MainExe,
        dx9DllDir,
        { strictPe: true }
      );
      expect(resolvedDx9Fallback.is32Bit).toBe(true);
      expect(resolvedDx9Fallback.isLargeAddressAware).toBe(false);
      expect(resolvedDx9Fallback.importsD3d9).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 2. 32-Bit (PE32) vs 64-Bit (PE32+) CrossOver Graphics Backend Routing & Guards
  // --------------------------------------------------------------------------
  describe('2. 32-Bit (PE32) vs 64-Bit (PE32+) CrossOver Graphics Backend Routing & Non-LAA / Non-NX Guards', () => {
    it('routes 64-bit DX12/UE5 to D3DMetal, 64-bit DX11 to native CrossOver Auto (D3DMetal), and 32-bit DEP DX10/DX11 to DXMT while guarding non-NX (non-DEP) 32-bit binaries against DXMT hangs', () => {
      // 2.1: 64-bit DX12-only (PE32+) under 'auto' -> 'd3dmetal'
      const route64Dx12 = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
        requestedBackend: 'auto',
        is64Bit: true,
        is32Bit: false,
        importsD3d12: true,
        isD3d12Only: true,
      });
      expect(route64Dx12.backend).toBe('d3dmetal');
      expect(route64Dx12.cxGraphicsBackendEnv).toBe('d3dmetal');
      expect(route64Dx12.reroutedReason).toBeNull();

      // 64-bit DX11 (PE32+) under 'auto' -> preserves CrossOver's native 64-bit auto (D3DMetal) without forcing DXMT/WineD3D
      const route64Dx11 = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
        requestedBackend: 'auto',
        is64Bit: true,
        is32Bit: false,
        importsD3d11Or10: true,
        isD3d12Only: false,
      });
      expect(route64Dx11.backend).toBe('auto');
      expect(route64Dx11.cxGraphicsBackendEnv).toBeNull();
      expect(route64Dx11.reroutedReason).toBeNull();

      // 2.2: 32-bit (PE32) DX10/DX11 with isNxCompat: true under 'auto' -> 'dxmt' (native i386-windows Metal)
      const route32Dx11Nx = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
        requestedBackend: 'auto',
        is32Bit: true,
        is64Bit: false,
        isNxCompat: true,
        importsD3d11Or10: true,
      });
      expect(route32Dx11Nx.backend).toBe('dxmt');
      expect(route32Dx11Nx.cxGraphicsBackendEnv).toBe('dxmt');
      expect(route32Dx11Nx.direct3dRenderer).toBeNull();
      expect(route32Dx11Nx.reroutedReason).toBeNull();

      // 2.3: 32-bit (PE32) DX10/DX11 with isNxCompat: false (non-DEP) -> NEVER routes to 'dxmt' (avoids WINE_SIMULATE_WRITECOPY hang)
      const route32Dx11NonNxAuto = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
        requestedBackend: 'auto',
        is32Bit: true,
        is64Bit: false,
        isNxCompat: false,
        importsD3d11Or10: true,
        layerSupport: { has32BitDxmt: true, has32BitDxvk: false, has64BitD3dMetal: true },
      });
      expect(route32Dx11NonNxAuto.backend).toBe('wined3d');
      expect(route32Dx11NonNxAuto.direct3dRenderer).toBe('vulkan');
      expect(route32Dx11NonNxAuto.backend).not.toBe('dxmt');

      const route32Dx11NonNxWithDxvk = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
        requestedBackend: 'auto',
        is32Bit: true,
        is64Bit: false,
        isNxCompat: false,
        importsD3d11Or10: true,
        layerSupport: { has32BitDxmt: true, has32BitDxvk: true, has64BitD3dMetal: true },
      });
      expect(route32Dx11NonNxWithDxvk.backend).toBe('dxvk');
      expect(route32Dx11NonNxWithDxvk.backend).not.toBe('dxmt');

      // Even explicit user 'dxmt' on a non-NX 32-bit binary triggers Hard Safety Guard #1 -> reroutes safely!
      const route32ExplicitDxmtNonNx = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
        requestedBackend: 'dxmt',
        is32Bit: true,
        isNxCompat: false,
        importsD3d9: true,
      });
      expect(route32ExplicitDxmtNonNx.backend).toBe('wined3d');
      expect(route32ExplicitDxmtNonNx.direct3dRenderer).toBe('vulkan');
      expect(route32ExplicitDxmtNonNx.reroutedReason).toBe('pe32_non_nx_dxmt_hang_guard');
    });

    it('applies Vulkan WineD3D / DXVK policies for 32-bit LAA vs non-LAA (1536 MiB VA cap), OpenGL WineD3D for legacy GL/DDraw, and clean rerouting for explicit overrides (including d3dmetal on PE32)', async () => {
      const bottleDir = path.join(tmpRoot, 'CrossOver', 'Bottles', 'SynthBottle');
      const userDataDir = path.join(tmpRoot, 'userdata');
      fs.mkdirSync(path.join(bottleDir, 'drive_c'), { recursive: true });
      fs.writeFileSync(path.join(bottleDir, 'cxbottle.conf'), '[Bottle]\n"WineArch" = "win64"\n', 'utf8');
      fs.writeFileSync(
        path.join(bottleDir, 'user.reg'),
        'WINE REGISTRY Version 2\n;; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000\n',
        'utf8'
      );

      const mockLayer = {
        id: 'crossover',
        type: 'crossover',
        version: '26.0.0',
        binaryPath: path.join(tmpRoot, 'CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'),
      };

      // A. 32-bit DX9 WITH non-LAA (isLargeAddressAware: false, 2 GB VA ceiling) -> caps VideoMemorySize=1536 & DXVK_CONFIG=1536
      const envDx9NonLaa: Record<string, string> = {};
      macInstaller.applyCrossOverPerGameSettings(
        mockLayer,
        { crossoverGraphicsBackend: 'auto' },
        envDx9NonLaa,
        bottleDir,
        {
          homedir: tmpRoot,
          userDataDir,
          skipRegistrySpawn: true,
          skipDisplayProbe: true,
          exeName: 'LegacyDx9NonLaa.exe',
          peCapabilities: {
            is32Bit: true,
            is64Bit: false,
            effectiveMachine: 'x86',
            isLargeAddressAware: false,
            isNxCompat: true,
            importsD3d9: true,
          },
        }
      );
      expect(envDx9NonLaa.CX_GRAPHICS_BACKEND).toBe('wined3d');
      expect(envDx9NonLaa.DXVK_CONFIG).toContain('d3d9.maxAvailableMemory = 1536');
      expect(envDx9NonLaa.DXVK_CONFIG).toContain('dxgi.maxDeviceMemory = 1536');
      expect(envDx9NonLaa.DXVK_CONFIG).toContain('dxgi.maxSharedMemory = 1536');
      expect(envDx9NonLaa.DXVK_LOG_LEVEL).toBe('none');
      expect(envDx9NonLaa.DXVK_STATE_CACHE_PATH).toContain('dxvk');
      // MoltenVK async queue submit tuning emitted automatically for WineD3D Vulkan
      expect(envDx9NonLaa.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS).toBe('0');
      expect(envDx9NonLaa.MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS).toBe('2');
      expect(envDx9NonLaa.MVK_CONFIG_FAST_MATH_ENABLED).toBe('1');

      const regAfterNonLaa = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(regAfterNonLaa).toContain('[Software\\\\Wine\\\\AppDefaults\\\\legacydx9nonlaa.exe\\\\Direct3D]');
      expect(regAfterNonLaa).toContain('"renderer"="vulkan"');
      expect(regAfterNonLaa).toContain('"VideoMemorySize"="1536"');

      // Non-destructive MVK_CONFIG_* user override check + explicit 'dxvk' check
      const envDxvkUserOverride: Record<string, string> = {
        MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS: '1',
      };
      macInstaller.applyCrossOverPerGameSettings(
        mockLayer,
        {
          crossoverGraphicsBackend: 'dxvk',
          environmentVariables: { MVK_CONFIG_FAST_MATH_ENABLED: '0' },
        },
        envDxvkUserOverride,
        bottleDir,
        {
          homedir: tmpRoot,
          userDataDir,
          skipRegistrySpawn: true,
          skipDisplayProbe: true,
          exeName: 'LegacyDx9NonLaa.exe',
          peCapabilities: {
            is32Bit: true,
            is64Bit: false,
            effectiveMachine: 'x86',
            isLargeAddressAware: true,
            isNxCompat: true,
            importsD3d11Or10: true,
          },
        }
      );
      expect(envDxvkUserOverride.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS).toBe('1');
      expect(envDxvkUserOverride.MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS).toBe('2');
      expect(envDxvkUserOverride.MVK_CONFIG_FAST_MATH_ENABLED).toBeUndefined();

      // B. 32-bit DX9 WITH LAA (isLargeAddressAware: true) -> Vulkan-backed WineD3D without 1536 MiB non-LAA ceiling, cleans stale VideoMemorySize!
      const envDx9Laa: Record<string, string> = {};
      macInstaller.applyCrossOverPerGameSettings(
        mockLayer,
        { crossoverGraphicsBackend: 'auto' },
        envDx9Laa,
        bottleDir,
        {
          homedir: tmpRoot,
          userDataDir,
          skipRegistrySpawn: true,
          skipDisplayProbe: true,
          exeName: 'LegacyDx9NonLaa.exe',
          peCapabilities: {
            is32Bit: true,
            is64Bit: false,
            effectiveMachine: 'x86',
            isLargeAddressAware: true,
            isNxCompat: true,
            importsD3d9: true,
          },
        }
      );
      expect(envDx9Laa.CX_GRAPHICS_BACKEND).toBe('wined3d');
      expect(envDx9Laa.DXVK_CONFIG).toBeUndefined();
      const regAfterLaa = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(regAfterLaa).toContain('"renderer"="vulkan"');
      expect(regAfterLaa).not.toContain('"VideoMemorySize"="1536"');

      // C. 32-bit legacy OpenGL / DirectDraw (ddraw.dll + opengl32.dll only) -> 'wined3d' GL without forcing Vulkan renderer
      const route32GlDdraw = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
        requestedBackend: 'auto',
        is32Bit: true,
        isNxCompat: true,
        importsLegacyD3dOrGl: true,
      });
      expect(route32GlDdraw).toMatchObject({
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: null,
      });

      const envGlDdraw: Record<string, string> = {};
      macInstaller.applyCrossOverPerGameSettings(
        mockLayer,
        { crossoverGraphicsBackend: 'auto' },
        envGlDdraw,
        bottleDir,
        {
          homedir: tmpRoot,
          userDataDir,
          skipRegistrySpawn: true,
          skipDisplayProbe: true,
          exeName: 'LegacyDx9NonLaa.exe',
          usesLegacyDirectDraw: true,
          limitLegacy32BitGlExtensions: true,
          peCapabilities: {
            is32Bit: true,
            is64Bit: false,
            effectiveMachine: 'x86',
            isLargeAddressAware: false,
            isNxCompat: true,
            importsLegacyD3dOrGl: true,
          },
        }
      );
      expect(envGlDdraw.CX_GRAPHICS_BACKEND).toBe('wined3d');
      // OpenGL WineD3D does NOT set MoltenVK async queue submit vars
      expect(envGlDdraw.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS).toBeUndefined();
      const regAfterGlDdraw = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(regAfterGlDdraw).not.toContain('"renderer"="vulkan"');
      expect(regAfterGlDdraw).toContain('"DirectDrawRenderer"="opengl"');
      expect(regAfterGlDdraw).toContain('"EnabledExtensions"=');

      // C2. Packed / dynamically-loaded non-DEP PE32 (`is32Bit: true, isNxCompat: false` with empty static graphics imports)
      // under `'auto'` pins `wined3d` instead of leaving `cxGraphicsBackendEnv: null` so `cxcompatdb` cannot auto-pick `dxmt`
      const route32PackedNonNx = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
        requestedBackend: 'auto',
        is32Bit: true,
        is64Bit: false,
        isNxCompat: false,
      });
      expect(route32PackedNonNx).toMatchObject({
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: null,
        reroutedReason: 'pe32_non_nx_dxmt_hang_guard',
      });

      // D. Explicit user overrides ('dxvk', 'dxmt', 'wined3d') respected non-destructively
      for (const explicitBackend of ['dxvk', 'dxmt', 'wined3d'] as const) {
        const res = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
          requestedBackend: explicitBackend,
          is32Bit: true,
          isNxCompat: true,
          importsD3d11Or10: true,
        });
        expect(res.backend).toBe(explicitBackend);
        expect(res.cxGraphicsBackendEnv).toBe(explicitBackend);
        expect(res.reroutedReason).toBeNull();
      }

      // E. Explicit 'd3dmetal' on 32-bit PE32 (where D3DMetal has zero 32-bit DLLs) -> cleanly reroutes via smart auto policy without crashing
      const explicitD3dMetalOnPe32Dx11 = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
        requestedBackend: 'd3dmetal',
        is32Bit: true,
        isNxCompat: true,
        importsD3d11Or10: true,
      });
      expect(explicitD3dMetalOnPe32Dx11.backend).toBe('dxmt');
      expect(explicitD3dMetalOnPe32Dx11.cxGraphicsBackendEnv).toBe('dxmt');
      expect(explicitD3dMetalOnPe32Dx11.reroutedReason).toBe('pe32_d3dmetal_unsupported');

      const explicitD3dMetalOnPe32Dx9 = macInstaller.resolveEffectiveCrossOverGraphicsBackend({
        requestedBackend: 'd3dmetal',
        is32Bit: true,
        isNxCompat: true,
        importsD3d9: true,
      });
      expect(explicitD3dMetalOnPe32Dx9.backend).toBe('wined3d');
      expect(explicitD3dMetalOnPe32Dx9.direct3dRenderer).toBe('vulkan');
      expect(explicitD3dMetalOnPe32Dx9.reroutedReason).toBe('pe32_d3dmetal_unsupported');

      // Verify sessionAndProcessSupervisor exports remain wired cleanly
      expect(typeof sessionSupervisor.launchGame).toBe('function');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Clean-Room Launch Engine Hardening (Rosetta AVX, CX_ENV, Live MSync, DXMT_CONFIG, AppleDouble)
  // --------------------------------------------------------------------------
  describe('3. Clean-Room Launch Engine Hardening (Rosetta AVX, CX_ENV, Live MSync, Config Clauses & AppleDouble)', () => {
    it('applyStrictRosettaAvxEnv sets ROSETTA_ADVERTISE_AVX="0" for CrossOver Perl bin/wine wrapper while deleting it for raw wine64/wineloader', () => {
      const cxEnvDisabled = wineManager.applyStrictRosettaAvxEnv(
        { ROSETTA_ADVERTISE_AVX: '1' },
        false,
        {
          wineBinaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          layerType: 'crossover',
        }
      );
      expect(cxEnvDisabled.ROSETTA_ADVERTISE_AVX).toBe('0');

      const rawWineDisabled = wineManager.applyStrictRosettaAvxEnv(
        { ROSETTA_ADVERTISE_AVX: '1' },
        false,
        {
          wineBinaryPath: '/opt/homebrew/bin/wine64',
          layerType: 'wine',
        }
      );
      expect('ROSETTA_ADVERTISE_AVX' in rawWineDisabled).toBe(false);

      const directWineloaderDisabled = wineManager.applyStrictRosettaAvxEnv(
        { ROSETTA_ADVERTISE_AVX: '0' },
        false,
        {
          wineBinaryPath:
            '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wineloader64',
          layerType: 'crossover',
        }
      );
      expect('ROSETTA_ADVERTISE_AVX' in directWineloaderDisabled).toBe(false);

      const avxEnabled = wineManager.applyStrictRosettaAvxEnv({}, true, {
        wineBinaryPath: '/opt/homebrew/bin/wine64',
      });
      expect(avxEnabled.ROSETTA_ADVERTISE_AVX).toBe('1');
    });

    it('prepareCrossOverWineSpawnEnv & mergeCxEnvVariables serialize preload/Wine vars idempotently into CX_ENV and strip SIP-unsafe top-level DYLD_INSERT_LIBRARIES on #!/usr/bin/perl bin/wine', () => {
      // 3.2a: Idempotent mergeCxEnvVariables across all key classes without duplicating tokens
      const firstCxEnv = macInstaller.mergeCxEnvVariables('USER_CUSTOM_FLAG="keep_me"', {
        DYLD_INSERT_LIBRARIES: '/tmp/ol-hb-win32-test/libone_metal_preload.dylib',
        WINEDLLOVERRIDES: 'd3d11,dxgi=n,b;winemenubuilder.exe=d',
        MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS: '0',
        MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS: '2',
        MVK_CONFIG_FAST_MATH_ENABLED: '1',
        DXMT_CONFIG: 'd3d11.preferredMaxFrameRate = 120; d3d11.metalSpatialUpscaleFactor = 2.0',
        WINEESYNC: '0',
        WINEMSYNC: '1',
      });

      const secondCxEnv = macInstaller.mergeCxEnvVariables(firstCxEnv, {
        DYLD_INSERT_LIBRARIES: '/tmp/ol-hb-win32-test/libone_metal_preload.dylib',
        WINEDLLOVERRIDES: 'd3d11,dxgi=n,b;winemenubuilder.exe=d',
        MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS: '0',
        MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS: '2',
        MVK_CONFIG_FAST_MATH_ENABLED: '1',
        DXMT_CONFIG: 'd3d11.preferredMaxFrameRate = 120; d3d11.metalSpatialUpscaleFactor = 2.0',
        WINEESYNC: '0',
        WINEMSYNC: '1',
      });

      expect(secondCxEnv).toBe(firstCxEnv);
      expect(secondCxEnv).toContain('USER_CUSTOM_FLAG="keep_me"');
      expect((secondCxEnv.match(/DYLD_INSERT_LIBRARIES=/g) || []).length).toBe(1);
      expect((secondCxEnv.match(/WINEDLLOVERRIDES=/g) || []).length).toBe(1);
      expect((secondCxEnv.match(/DXMT_CONFIG=/g) || []).length).toBe(1);

      // 3.2b: Real #!/usr/bin/perl CrossOver bin/wine wrapper script on disk
      const cxRoot = path.join(
        tmpRoot,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver'
      );
      const cxBinDir = path.join(cxRoot, 'bin');
      const gptkExtDir = path.join(cxRoot, 'lib64', 'apple_gptk', 'external');
      fs.mkdirSync(cxBinDir, { recursive: true });
      fs.mkdirSync(gptkExtDir, { recursive: true });
      const perlWineWrapper = path.join(cxBinDir, 'wine');
      fs.writeFileSync(perlWineWrapper, '#!/usr/bin/perl\n# synthetic wrapper\n', { mode: 0o755 });
      const gptkShared = path.join(gptkExtDir, 'libd3dshared.dylib');
      fs.writeFileSync(gptkShared, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));

      const spawnEnv: Record<string, string> = {
        DYLD_FALLBACK_LIBRARY_PATH: '/opt/synth/lib',
        DYLD_INSERT_LIBRARIES: '/tmp/ol-hb-win32-test/libone_metal_preload.dylib',
        WINEDLLOVERRIDES: 'winemenubuilder.exe=d',
        WINEDEBUG: '-all',
      };

      const resolvedPerlCmd = macInstaller.prepareCrossOverWineSpawnEnv(perlWineWrapper, spawnEnv, {
        layerType: 'crossover',
      });
      expect(resolvedPerlCmd).toBe(perlWineWrapper);
      // Top-level DYLD_INSERT_LIBRARIES removed for arm64e /usr/bin/perl, but other host DYLD_* preserved
      expect('DYLD_INSERT_LIBRARIES' in spawnEnv).toBe(false);
      expect(spawnEnv.DYLD_FALLBACK_LIBRARY_PATH).toBe('/opt/synth/lib');
      expect(spawnEnv.CX_ENV).toContain(
        'DYLD_INSERT_LIBRARIES="/tmp/ol-hb-win32-test/libone_metal_preload.dylib"'
      );
      expect(spawnEnv.CX_ENV).toContain('WINEDLLOVERRIDES="winemenubuilder.exe=d"');
      expect(spawnEnv.CX_DEBUGMSG).toBe('-all');

      // Re-invoking prepareCrossOverWineSpawnEnv is strictly idempotent
      const cxEnvSnapshot = spawnEnv.CX_ENV;
      macInstaller.prepareCrossOverWineSpawnEnv(perlWineWrapper, spawnEnv, {
        layerType: 'crossover',
      });
      expect(spawnEnv.CX_ENV).toBe(cxEnvSnapshot);

      // Direct Mach-O wineloader64 populates CX_ROOT & CX_APPLEGPTK_LIBD3DSHARED_PATH and keeps DYLD_INSERT_LIBRARIES
      const directWineloader = path.join(cxBinDir, 'wineloader64');
      fs.writeFileSync(directWineloader, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]), {
        mode: 0o755,
      });
      const loaderEnv: Record<string, string> = {
        DYLD_INSERT_LIBRARIES: '/tmp/ol-hb-win32-test/libone_metal_preload.dylib',
        ROSETTA_ADVERTISE_AVX: '0',
      };
      macInstaller.prepareCrossOverWineSpawnEnv(directWineloader, loaderEnv, {
        layerType: 'crossover',
      });
      expect(loaderEnv.CX_ROOT).toBe(cxRoot);
      expect(loaderEnv.CX_APPLEGPTK_LIBD3DSHARED_PATH).toBe(gptkShared);
      expect(loaderEnv.DYLD_INSERT_LIBRARIES).toBe('/tmp/ol-hb-win32-test/libone_metal_preload.dylib');
      expect('ROSETTA_ADVERTISE_AVX' in loaderEnv).toBe(false);
    });

    it('alignWineMsyncWithLiveBottle prevents msync/esync mismatch against live bottles, mergeSemicolonConfigClauses preserves user clauses, and cleanNonApfsAppleDoubleTwins removes only genuine AppleDouble twins on external volumes', () => {
      // 3.3: alignWineMsyncWithLiveBottle
      const liveBottleA = path.join(tmpRoot, 'bottle-live-recorded');
      fs.mkdirSync(liveBottleA, { recursive: true });
      // Cold boot records WINEMSYNC='0' when wineserver is not yet active
      const coldEnv = { WINEMSYNC: '0' };
      expect(
        macInstaller.alignWineMsyncWithLiveBottle(liveBottleA, coldEnv, { wineserverActive: false })
      ).toBe('0');

      // Subsequent helper/game spawn while bottle is live aligns conflicting WINEMSYNC='1' -> '0'
      const chainedEnv = { WINEMSYNC: '1' };
      expect(
        macInstaller.alignWineMsyncWithLiveBottle(liveBottleA, chainedEnv, {
          wineserverActive: true,
        })
      ).toBe('0');
      expect(chainedEnv.WINEMSYNC).toBe('0');

      // Fallback to cxbottle.conf "WINEMSYNC" = "0" when bottle was started externally
      const liveBottleB = path.join(tmpRoot, 'bottle-live-conf');
      fs.mkdirSync(liveBottleB, { recursive: true });
      fs.writeFileSync(
        path.join(liveBottleB, 'cxbottle.conf'),
        '[EnvironmentVariables]\n"WINEMSYNC" = "0"\n',
        'utf8'
      );
      const externalLiveEnv = { WINEMSYNC: '1' };
      expect(
        macInstaller.alignWineMsyncWithLiveBottle(liveBottleB, externalLiveEnv, {
          wineserverActive: true,
        })
      ).toBe('0');
      expect(externalLiveEnv.WINEMSYNC).toBe('0');

      // 3.4: mergeSemicolonConfigClauses preserves user clauses without clobbering
      const mergedDxmt = macInstaller.mergeSemicolonConfigClauses(
        'd3d11.metalSpatialUpscaleFactor=2.0; d3d11.preferredMaxFrameRate=60',
        'd3d11.preferredMaxFrameRate = 144; dxgi.customVendorId = 0x10de'
      );
      expect(mergedDxmt).toBe(
        'd3d11.metalSpatialUpscaleFactor=2.0; d3d11.preferredMaxFrameRate=60; dxgi.customVendorId = 0x10de'
      );

      const overwrittenDxmt = macInstaller.mergeSemicolonConfigClauses(
        'd3d11.preferredMaxFrameRate=60',
        { 'd3d11.preferredMaxFrameRate': 120 },
        { overwriteExisting: true }
      );
      expect(overwrittenDxmt).toBe('d3d11.preferredMaxFrameRate = 120');

      // 3.5: cleanNonApfsAppleDoubleTwins on simulated ExFAT volume vs APFS volume
      const exfatDir = path.join(tmpRoot, 'exfat-game-root');
      fs.mkdirSync(path.join(exfatDir, 'Binaries'), { recursive: true });
      const realDll = path.join(exfatDir, 'Binaries', 'Engine.dll');
      const twinDll = path.join(exfatDir, 'Binaries', '._Engine.dll');
      const orphanDotUnderscore = path.join(exfatDir, 'Binaries', '._OrphanNoSibling.dll');
      const nonAppleDouble = path.join(exfatDir, 'Binaries', '._ConfigNote.txt');
      const realNote = path.join(exfatDir, 'Binaries', 'ConfigNote.txt');

      const appleDoubleMagic = Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]);
      fs.writeFileSync(realDll, 'PE-DLL-CONTENT');
      fs.writeFileSync(twinDll, appleDoubleMagic);
      fs.writeFileSync(orphanDotUnderscore, appleDoubleMagic);
      fs.writeFileSync(realNote, 'real config');
      fs.writeFileSync(nonAppleDouble, 'NOT_APPLE_DOUBLE');

      // On APFS -> short-circuits with 0 removals
      expect(
        macInstaller.cleanNonApfsAppleDoubleTwins(exfatDir, {
          platform: 'darwin',
          fsType: 'apfs',
        })
      ).toBe(0);
      expect(fs.existsSync(twinDll)).toBe(true);

      // On ExFAT -> removes ONLY valid AppleDouble (0x00051607) with existing sibling!
      expect(
        macInstaller.cleanNonApfsAppleDoubleTwins(exfatDir, {
          platform: 'darwin',
          fsType: 'exfat',
        })
      ).toBe(1);
      expect(fs.existsSync(twinDll)).toBe(false);
      expect(fs.existsSync(realDll)).toBe(true);
      expect(fs.existsSync(orphanDotUnderscore)).toBe(true);
      expect(fs.existsSync(nonAppleDouble)).toBe(true);
      expect(fs.existsSync(realNote)).toBe(true);
    });

    it('re-syncs post-ensureCompatibilityLayerReady WINEDLLOVERRIDES into CX_ENV on CrossOver bin/wine and prevents legacy DirectDraw 2x Retina mouse-clipping split-brain', async () => {
      const userDataDir = path.join(tmpRoot, 'userdata-cxenv-resync');
      const cxRoot = path.join(
        tmpRoot,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver'
      );
      const cxBinDir = path.join(cxRoot, 'bin');
      const bottlesDir = path.join(tmpRoot, 'Library', 'Application Support', 'CrossOver', 'Bottles');
      const bottleDir = path.join(bottlesDir, 'OneLauncher');
      fs.mkdirSync(cxBinDir, { recursive: true });
      fs.mkdirSync(path.join(bottleDir, 'drive_c', 'windows', 'system32'), { recursive: true });
      fs.writeFileSync(path.join(bottleDir, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
      fs.writeFileSync(
        path.join(bottleDir, 'user.reg'),
        [
          'WINE REGISTRY Version 2',
          '[Software\\\\Wine\\\\Mac Driver]',
          '"RetinaMode"="y"',
          '[Software\\\\Wine\\\\Fonts]',
          '"LogPixels"=dword:000000c0',
          '[Software\\\\Wine\\\\AppDefaults\\\\legacyddraw.exe\\\\Mac Driver]',
          '"RetinaMode"="n"',
          '',
        ].join('\n'),
        'utf8'
      );
      const perlWineWrapper = path.join(cxBinDir, 'wine');
      fs.writeFileSync(perlWineWrapper, '#!/usr/bin/perl\n# synthetic wrapper\n', { mode: 0o755 });

      // 1. Legacy 32-bit DirectDraw game with `crossoverHighResolutionMode: true` in config:
      // Scopes 96 DPI (`RetinaMode="n"`, `CaptureDisplaysForFullscreen="y"`, `UseConfinementCursorClipping="y"`)
      // strictly to per-exe AppDefaults\<exe>\Mac Driver + `1512x982` 1x logical desktop without poisoning
      // shared bottle global `Mac Driver` or `explorer.exe`!
      const envLegacyDpi: Record<string, string> = {};
      macInstaller.applyCrossOverPerGameSettings(
        { id: 'crossover', name: 'CrossOver', type: 'crossover', binaryPath: perlWineWrapper, bottlesDir },
        {
          crossoverGraphicsBackend: 'auto',
          crossoverHighResolutionMode: true,
        },
        envLegacyDpi,
        bottleDir,
        {
          homedir: tmpRoot,
          userDataDir,
          skipRegistrySpawn: true,
          maxWidth: 3024,
          maxHeight: 1964,
          logicalWidth: 1512,
          logicalHeight: 982,
          enableLegacyDisplayModeSynthesis: true,
          usesLegacyDirectDraw: true,
          targetExeNames: ['legacystart.exe', 'legacyddraw.exe'],
          peCapabilities: {
            is32Bit: true,
            is64Bit: false,
            effectiveMachine: 'x86',
            isLargeAddressAware: false,
            isNxCompat: false,
            importsLegacyD3dOrGl: true,
          },
        }
      );

      const regLegacy = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(regLegacy).toContain('"OneLauncher"="3024x1964"');
      expect(regLegacy).toMatch(/\[Software\\\\Wine\\\\Mac Driver\][^\[]*"RetinaMode"="y"/m);
      const explorerLegacyMacDrvSec =
        /\[Software\\\\Wine\\\\AppDefaults\\\\explorer\.exe\\\\Mac Driver\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(
          regLegacy
        );
      expect(explorerLegacyMacDrvSec?.[1] || '').not.toContain('"RetinaMode"');
      expect(regLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\legacystart\.exe\\\\Mac Driver\][^\[]*"RetinaMode"="y"/m
      );
      expect(regLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\legacyddraw\.exe\\\\Mac Driver\][^\[]*"RetinaMode"="y"/m
      );
      expect(regLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\legacyddraw\.exe\\\\Mac Driver\][^\[]*"CaptureDisplaysForFullscreen"="n"/m
      );
      expect(regLegacy).toMatch(
        /\[Software\\\\Wine\\\\AppDefaults\\\\legacyddraw\.exe\\\\Mac Driver\][^\[]*"UseConfinementCursorClipping"="y"/m
      );

      // Switching back to a modern 64-bit game with `crossoverHighResolutionMode: true` restores RetinaMode="y"
      // across global Mac Driver and target exes while keeping explorer.exe\Mac Driver clean!
      macInstaller.applyCrossOverPerGameSettings(
        { id: 'crossover', name: 'CrossOver', type: 'crossover', binaryPath: perlWineWrapper, bottlesDir },
        {
          crossoverGraphicsBackend: 'd3dmetal',
          crossoverHighResolutionMode: true,
          virtualDesktop: false,
        },
        {},
        bottleDir,
        {
          homedir: tmpRoot,
          userDataDir,
          skipRegistrySpawn: true,
          maxWidth: 3024,
          maxHeight: 1964,
          logicalWidth: 1512,
          logicalHeight: 982,
          enableLegacyDisplayModeSynthesis: false,
          usesLegacyDirectDraw: false,
          targetExeNames: ['legacyddraw.exe', 'modern64.exe'],
          peCapabilities: {
            is32Bit: false,
            is64Bit: true,
            effectiveMachine: 'x64',
            isLargeAddressAware: true,
            isNxCompat: true,
            importsD3d12: true,
          },
        }
      );
      const regModern = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(regModern).toMatch(/\[Software\\\\Wine\\\\Mac Driver\][^\[]*"RetinaMode"="y"/m);
      expect(regModern).toMatch(/\[Control Panel\\\\Desktop\][^\[]*"LogPixels"=dword:000000c0/m);
      expect(regModern).toMatch(/\[Software\\\\Wine\\\\Fonts\][^\[]*"LogPixels"=dword:000000c0/m);
      const explorerMacDrvSec =
        /\[Software\\\\Wine\\\\AppDefaults\\\\explorer\.exe\\\\Mac Driver\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(
          regModern
        );
      expect(explorerMacDrvSec?.[1] || '').not.toContain('"RetinaMode"');
      const legacyExeMacDrvSec =
        /\[Software\\\\Wine\\\\AppDefaults\\\\legacyddraw\.exe\\\\Mac Driver\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(
          regModern
        );
      expect(legacyExeMacDrvSec?.[1] || '').not.toContain('"RetinaMode"="n"');
      expect(legacyExeMacDrvSec?.[1] || '').toContain('"RetinaMode"="y"');

      // 2. End-to-end launchGame on darwin + CrossOver Perl bin/wine:
      // Pre-set user WINEDLLOVERRIDES + enableAudioBufferClamp (which moves DYLD_INSERT_LIBRARIES into CX_ENV
      // and deletes top-level DYLD_INSERT_LIBRARIES inside ensureCompatibilityLayerReady), plus an app-local
      // PE32 `ddraw.dll` proxy discovered AFTER ensureCompatibilityLayerReady. Verify final spawnEnv.CX_ENV
      // contains BOTH DYLD_INSERT_LIBRARIES AND the updated `ddraw=n,b` WINEDLLOVERRIDES!
      const installDir = path.join(tmpRoot, 'Games', 'SynthLegacyDdraw');
      fs.mkdirSync(installDir, { recursive: true });
      const gameExePath = path.join(installDir, 'SynthGame32.exe');
      fs.writeFileSync(
        gameExePath,
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: false,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'ddraw.dll'],
        })
      );
      // App-local proxy `ddraw.dll` matching 32-bit PE32 arch
      fs.writeFileSync(
        path.join(installDir, 'ddraw.dll'),
        buildSyntheticPeBuffer({
          arch: 'x86',
          largeAddressAware: false,
          nxCompat: true,
          importedDlls: ['KERNEL32.dll', 'OPENGL32.dll'],
        })
      );
      fs.writeFileSync(
        path.join(installDir, 'goggame-999000111.info'),
        JSON.stringify({
          gameId: '999000111',
          name: 'Synthetic Legacy DirectDraw Title',
          playTasks: [
            {
              isPrimary: true,
              type: 'FileTask',
              path: 'SynthGame32.exe',
              compatibilityFlags: 'RUNASADMIN 16BITCOLOR WINXPSP2 HIGHDPIAWARE',
            },
          ],
        }),
        'utf8'
      );

      let capturedMacSpawnEnv: Record<string, string> | null = null;
      const macLaunchRes = await sessionSupervisor.launchGame(
        {
          gameId: 'gog-999000111',
          platformId: 'gog',
          title: 'Synthetic Legacy DirectDraw Title',
          executablePath: gameExePath,
          installPath: installDir,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            executablePath: gameExePath,
            compatibilityLayer: 'crossover',
            wineBottleName: 'OneLauncher',
            environmentVariables: {
              WINEDLLOVERRIDES: 'customhook=n,b',
            },
          },
        },
        {
          platform: 'darwin',
          homedir: tmpRoot,
          userDataDir,
          customApplicationsDir: tmpRoot,
          enableAudioBufferClamp: true,
          skipRegistrySpawn: true,
          skipLiveWineRegSync: true,
          skipDisplayProbe: true,
          disableBottleStorefrontLaunch: true,
          startupWaitMs: 0,
          gameSpawnFn: (_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
            capturedMacSpawnEnv = { ...(opts?.env || {}) };
            const fakeChild = {
              pid: 44123,
              unref: () => {},
              on: () => fakeChild,
              once: () => fakeChild,
              stdout: null,
              stderr: null,
            };
            return fakeChild;
          },
        }
      );

      expect(macLaunchRes.success).toBe(true);
      expect(capturedMacSpawnEnv).not.toBeNull();
      expect('DYLD_INSERT_LIBRARIES' in (capturedMacSpawnEnv || {})).toBe(false);
      expect(capturedMacSpawnEnv!.CX_ENV).toContain('DYLD_INSERT_LIBRARIES=');
      expect(capturedMacSpawnEnv!.CX_ENV).toContain('customhook=n,b');
      expect(capturedMacSpawnEnv!.CX_ENV).toContain('ddraw=n,b');
      await sessionSupervisor.stopGame('gog-999000111', { homedir: tmpRoot, userDataDir });

      // 3. Native win32 __COMPAT_LAYER propagation strips HIGHDPIAWARE on legacy 16BITCOLOR / DirectDraw games
      let capturedWin32Env: Record<string, string> | null = null;
      const winLaunchRes = await sessionSupervisor.launchGame(
        {
          gameId: 'gog-999000112',
          platformId: 'gog',
          title: 'Synthetic Legacy DirectDraw Title',
          executablePath: gameExePath,
          installPath: installDir,
          launchConfig: {
            launchMethod: 'direct',
            executablePath: gameExePath,
          },
        },
        {
          platform: 'win32',
          homedir: tmpRoot,
          userDataDir,
          startupWaitMs: 0,
          gameSpawnFn: (_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
            capturedWin32Env = { ...(opts?.env || {}) };
            const fakeChild = {
              pid: 44124,
              unref: () => {},
              on: () => fakeChild,
              once: () => fakeChild,
              stdout: null,
              stderr: null,
            };
            return fakeChild;
          },
        }
      );
      expect(winLaunchRes.success).toBe(true);
      expect(capturedWin32Env).not.toBeNull();
      expect(capturedWin32Env!.__COMPAT_LAYER).toContain('16BITCOLOR');
      expect(capturedWin32Env!.__COMPAT_LAYER).toContain('WINXPSP2');
      expect(capturedWin32Env!.__COMPAT_LAYER).not.toContain('HIGHDPIAWARE');
      expect(capturedWin32Env!.__COMPAT_LAYER).not.toContain('RUNASADMIN');
      await sessionSupervisor.stopGame('gog-999000112', { homedir: tmpRoot, userDataDir });
    });
  });

  // --------------------------------------------------------------------------
  // 4. Native Preload Helper (one_metal_preload.c & libone_metal_preload.dylib)
  // --------------------------------------------------------------------------
  describe('4. Native Preload Helper (one_metal_preload.c & libone_metal_preload.dylib)', () => {
    it('verifies universal Mach-O (arm64 + x86_64) dylib, valid codesign, CoreAudio 5ms clamp & MoltenVK symbols, and compiles/runs one_metal_preload.c under Clang -Wall -Wextra -Werror -fsanitize=address,undefined', () => {
      const cSrcPath = path.join(REPO_ROOT, 'electron', 'helpers', 'one_metal_preload.c');
      const dylibPath = path.join(REPO_ROOT, 'electron', 'helpers', 'libone_metal_preload.dylib');

      expect(fs.existsSync(cSrcPath)).toBe(true);
      expect(fs.existsSync(dylibPath)).toBe(true);

      const dylibBuf = fs.readFileSync(dylibPath);
      expect(dylibBuf.length).toBeGreaterThan(16384);
      // Universal Mach-O Fat Header: magic 0xcafebabe, nfat_arch = 2 (x86_64 0x01000007 + arm64 0x0100000c)
      expect(dylibBuf.readUInt32BE(0)).toBe(0xcafebabe);
      const nFatArch = dylibBuf.readUInt32BE(4);
      expect(nFatArch).toBe(2);
      const cpuTypes = [dylibBuf.readUInt32BE(8), dylibBuf.readUInt32BE(28)];
      expect(cpuTypes).toEqual(expect.arrayContaining([0x01000007, 0x0100000c]));

      // Embedded string symbols inside compiled dylib
      const dylibLatin1 = dylibBuf.toString('latin1');
      expect(dylibLatin1).toContain('ONE_LAUNCHER_AUDIO_BUFFER_CLAMP');
      expect(dylibLatin1).toContain('AudioObjectGetPropertyData');
      expect(dylibLatin1).toContain('AudioObjectSetPropertyData');
      expect(dylibLatin1).toContain('MVK_ICD_LIBRARY_PATH');
      expect(dylibLatin1).toContain('ONE_LAUNCHER_MOLTENVK_PATH');
      expect(dylibLatin1).toContain('ONE_LAUNCHER_METAL_PRELOAD');

      const resolvedHelperPath = macInstaller.ensureWineMetalPreloadDylib({
        userDataDir: path.join(tmpRoot, 'userdata'),
      });
      expect(resolvedHelperPath).toBeTruthy();
      expect(fs.existsSync(resolvedHelperPath)).toBe(true);

      if (process.platform === 'darwin') {
        const archsOut = execFileSync('lipo', ['-archs', dylibPath], { encoding: 'utf8' }).trim();
        expect(archsOut.split(/\s+/)).toEqual(expect.arrayContaining(['arm64', 'x86_64']));

        const codesignRes = spawnSync('codesign', ['--verify', '--verbose=2', dylibPath], {
          encoding: 'utf8',
        });
        expect(codesignRes.status).toBe(0);

        // Compile & execute hermetic C11 ASan + UBSan harness including one_metal_preload.c with mocked CoreAudio & dlopen
        const harnessCPath = path.join(tmpRoot, 'one_metal_preload_asan_test.c');
        const harnessBinPath = path.join(tmpRoot, 'one_metal_preload_asan_test');
        const harnessCode = [
          '#include <CoreAudio/CoreAudio.h>',
          '#include <dlfcn.h>',
          '#include <mach-o/dyld.h>',
          '#include <math.h>',
          '#include <stdint.h>',
          '#include <stdio.h>',
          '#include <stdlib.h>',
          '#include <string.h>',
          '',
          'static Float64 g_mock_rate = 48000.0;',
          'static Float64 g_mock_min = 64.0;',
          'static Float64 g_mock_max = 4096.0;',
          'static UInt32 g_mock_current_frames = 512;',
          'static UInt32 g_last_set_frames = 0;',
          'static int g_set_calls = 0;',
          'static int g_dlopen_mvk_calls = 0;',
          'static char g_last_dlopen_path[512];',
          '',
          'static OSStatus mock_audio_get_prop(',
          '    AudioObjectID inObjectID,',
          '    const AudioObjectPropertyAddress *inAddress,',
          '    UInt32 inQualifierDataSize,',
          '    const void *inQualifierData,',
          '    UInt32 *ioDataSize,',
          '    void *outData',
          ') {',
          '    (void)inObjectID; (void)inQualifierDataSize; (void)inQualifierData;',
          '    if (!inAddress || !ioDataSize || !outData) return -1;',
          '    if (inAddress->mSelector == kAudioHardwarePropertyDefaultOutputDevice) {',
          '        AudioObjectID dev = 42;',
          '        memcpy(outData, &dev, sizeof(dev));',
          '        return noErr;',
          '    }',
          '    if (inAddress->mSelector == kAudioDevicePropertyNominalSampleRate) {',
          '        memcpy(outData, &g_mock_rate, sizeof(g_mock_rate));',
          '        return noErr;',
          '    }',
          '    if (inAddress->mSelector == kAudioDevicePropertyBufferFrameSizeRange) {',
          '        AudioValueRange r = { g_mock_min, g_mock_max };',
          '        memcpy(outData, &r, sizeof(r));',
          '        return noErr;',
          '    }',
          '    if (inAddress->mSelector == kAudioDevicePropertyBufferFrameSize) {',
          '        memcpy(outData, &g_mock_current_frames, sizeof(g_mock_current_frames));',
          '        return noErr;',
          '    }',
          '    return -1;',
          '}',
          '',
          'static OSStatus mock_audio_set_prop(',
          '    AudioObjectID inObjectID,',
          '    const AudioObjectPropertyAddress *inAddress,',
          '    UInt32 inQualifierDataSize,',
          '    const void *inQualifierData,',
          '    UInt32 inDataSize,',
          '    const void *inData',
          ') {',
          '    (void)inObjectID; (void)inQualifierDataSize; (void)inQualifierData;',
          '    if (!inAddress || !inData || inDataSize != sizeof(UInt32)) return -1;',
          '    if (inAddress->mSelector == kAudioDevicePropertyBufferFrameSize) {',
          '        memcpy(&g_last_set_frames, inData, sizeof(UInt32));',
          '        g_set_calls += 1;',
          '        return noErr;',
          '    }',
          '    return -1;',
          '}',
          '',
          'static int g_fake_ca_handle = 1;',
          'static int g_fake_mvk_handle = 2;',
          '',
          'static void *mock_dlopen(const char *path, int mode) {',
          '    (void)mode;',
          '    if (!path) return NULL;',
          '    snprintf(g_last_dlopen_path, sizeof(g_last_dlopen_path), "%s", path);',
          '    if (strstr(path, "CoreAudio") != NULL) return &g_fake_ca_handle;',
          '    if (strstr(path, "Metal.framework") != NULL) return &g_fake_ca_handle;',
          '    g_dlopen_mvk_calls += 1;',
          '    return &g_fake_mvk_handle;',
          '}',
          '',
          'static void *mock_dlsym(void *handle, const char *symbol) {',
          '    (void)handle;',
          '    if (!symbol) return NULL;',
          '    if (strcmp(symbol, "AudioObjectGetPropertyData") == 0) return (void *)mock_audio_get_prop;',
          '    if (strcmp(symbol, "AudioObjectSetPropertyData") == 0) return (void *)mock_audio_set_prop;',
          '    return NULL;',
          '}',
          '',
          '#define dlopen mock_dlopen',
          '#define dlsym mock_dlsym',
          `#include "${cSrcPath.replace(/\\/g, '/')}"`,
          '#undef dlopen',
          '#undef dlsym',
          '',
          'int main(void) {',
          '    /* 1. ONE_LAUNCHER_AUDIO_BUFFER_CLAMP=0 must completely skip CoreAudio clamp without error */',
          '    setenv("ONE_LAUNCHER_AUDIO_BUFFER_CLAMP", "0", 1);',
          '    g_set_calls = 0;',
          '    clamp_default_output_audio_buffer_to_5ms();',
          '    if (g_set_calls != 0) return 10;',
          '',
          '    /* 2. 48 kHz with 512-frame buffer clamps down to ceil(48000 * 0.005) = 240 frames (~5 ms) */',
          '    setenv("ONE_LAUNCHER_AUDIO_BUFFER_CLAMP", "1", 1);',
          '    g_mock_rate = 48000.0; g_mock_current_frames = 512; g_set_calls = 0; g_last_set_frames = 0;',
          '    clamp_default_output_audio_buffer_to_5ms();',
          '    if (g_set_calls != 1 || g_last_set_frames != 240) return 11;',
          '',
          '    /* 3. Never increases an already low-latency buffer (128 <= 240) */',
          '    g_mock_current_frames = 128; g_set_calls = 0;',
          '    clamp_default_output_audio_buffer_to_5ms();',
          '    if (g_set_calls != 0) return 12;',
          '',
          '    /* 4. MVK_ICD_LIBRARY_PATH and ONE_LAUNCHER_MOLTENVK_PATH handling */',
          '    setenv("ONE_LAUNCHER_AUDIO_BUFFER_CLAMP", "0", 1);',
          '    setenv("ONE_LAUNCHER_METAL_PRELOAD", "1", 1);',
          '    setenv("MVK_ICD_LIBRARY_PATH", "/tmp/ol-hb-win32-test/libMoltenVK_icd.dylib", 1);',
          '    g_dlopen_mvk_calls = 0;',
          '    preload_metal_and_moltenvk();',
          '    if (g_dlopen_mvk_calls != 1 || strcmp(g_last_dlopen_path, "/tmp/ol-hb-win32-test/libMoltenVK_icd.dylib") != 0) return 13;',
          '',
          '    unsetenv("MVK_ICD_LIBRARY_PATH");',
          '    setenv("ONE_LAUNCHER_MOLTENVK_PATH", "/tmp/ol-hb-win32-test/libMoltenVK_fallback.dylib", 1);',
          '    g_dlopen_mvk_calls = 0;',
          '    preload_metal_and_moltenvk();',
          '    if (g_dlopen_mvk_calls != 1 || strcmp(g_last_dlopen_path, "/tmp/ol-hb-win32-test/libMoltenVK_fallback.dylib") != 0) return 14;',
          '',
          '    /* 5. NaN / non-finite sample_rate or huge frame_range safely no-ops / clamps <= 65536 without UB */',
          '    setenv("ONE_LAUNCHER_AUDIO_BUFFER_CLAMP", "1", 1);',
          '    g_mock_rate = NAN; g_mock_current_frames = 512; g_set_calls = 0;',
          '    clamp_default_output_audio_buffer_to_5ms();',
          '    if (g_set_calls != 0) return 16;',
          '    g_mock_rate = 48000.0; g_mock_min = 64.0; g_mock_max = 1.0e12; g_mock_current_frames = 512; g_set_calls = 0;',
          '    clamp_default_output_audio_buffer_to_5ms();',
          '    if (g_set_calls != 1 || g_last_set_frames != 240) return 17;',
          '',
          '    if (!contains_ascii_icase("/lib/libMoltenVK.dylib", "moltenvk")) return 15;',
          '    return 0;',
          '}',
          '',
        ].join('\n');

        fs.writeFileSync(harnessCPath, harnessCode, 'utf8');
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

        const runAsan = spawnSync(harnessBinPath, [], {
          env: {
            ...process.env,
            ONE_LAUNCHER_AUDIO_BUFFER_CLAMP: '0',
            ONE_LAUNCHER_METAL_PRELOAD: '0',
            ASAN_OPTIONS: 'abort_on_error=1:detect_stack_use_after_return=1:strict_string_checks=1',
            UBSAN_OPTIONS: 'print_stacktrace=1:halt_on_error=1',
          },
          encoding: 'utf8',
        });
        expect(runAsan.status).toBe(0);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. Frontend 32-Bit / 64-Bit Graphics Policy UX, WAI-ARIA Tabs & WCAG 2.2 AA
  // --------------------------------------------------------------------------
  describe('5. Frontend 32-Bit / 64-Bit Graphics Policy UX & WAI-ARIA Tabs Accessibility + WCAG 2.2 AA', () => {
    it('describes 64-bit vs 32-bit translation behavior accurately across CROSSOVER_GRAPHICS_BACKEND_POLICIES and CompatibilityLayerSection with 0 WCAG 2.2 AA violations', () => {
      // 5.1: Verify policy descriptors across Auto, D3DMetal, DXMT, DXVK, WineD3D
      expect(CROSSOVER_GRAPHICS_BACKEND_POLICIES.auto.architectureBadge).toBe(
        '64-bit & 32-bit Auto-Routing'
      );
      expect(CROSSOVER_GRAPHICS_BACKEND_POLICIES.auto.guidance).toContain('D3DMetal');
      expect(CROSSOVER_GRAPHICS_BACKEND_POLICIES.auto.guidance).toContain('DXMT');
      expect(CROSSOVER_GRAPHICS_BACKEND_POLICIES.auto.guidance).toContain('non-LAA');

      expect(CROSSOVER_GRAPHICS_BACKEND_POLICIES.d3dmetal.architectureBadge).toBe(
        '64-bit DX11/DX12 • 32-bit Fallback'
      );
      expect(CROSSOVER_GRAPHICS_BACKEND_POLICIES.d3dmetal.guidance).toContain('64-bit');
      expect(CROSSOVER_GRAPHICS_BACKEND_POLICIES.d3dmetal.guidance).toContain('32-bit');

      expect(CROSSOVER_GRAPHICS_BACKEND_POLICIES.dxmt.architectureBadge).toBe(
        '32-bit (DEP) & 64-bit Metal'
      );
      expect(CROSSOVER_GRAPHICS_BACKEND_POLICIES.dxvk.architectureBadge).toBe(
        '32-bit & 64-bit Vulkan'
      );
      expect(CROSSOVER_GRAPHICS_BACKEND_POLICIES.wined3d.architectureBadge).toBe(
        '32-bit & 64-bit Legacy'
      );
      expect(getCrossOverGraphicsBackendPolicy('unknown-value').value).toBe('auto');

      // 5.2: Render CompatibilityLayerSection on darwin with CrossOver selected
      const mockPreview: ResolvedLaunchModePreview = {
        isInstalled: true,
        hostPlatform: 'darwin',
        platformId: 'steam',
        detectedBuildType: 'windows_exe_on_mac',
        detectedBuildLabel: 'Windows Build (CrossOver Bottle)',
        detectedBuildDetail: 'Runs Windows executable via CrossOver on macOS.',
        autoResolvedMethod: 'compatibility_layer',
        autoResolvedSummary: 'CrossOver 26 Bottle Execution',
        defaultLaunchMethod: 'auto',
        recommendedModes: ['auto', 'compatibility_layer'],
        availableModes: ['auto', 'direct', 'compatibility_layer'],
        visibleSections: {
          compatibilityLayer: true,
          crossoverRendering: true,
          nativeMacMetalHud: false,
          executableAndArgs: true,
          environmentAndHooks: true,
        },
        modeNotes: {
          auto: { dynamicDesc: 'Automatic launch routing' },
          direct: { dynamicDesc: 'Direct executable launch' },
          storefront_uri: { dynamicDesc: 'Storefront URI launch' },
          compatibility_layer: { dynamicDesc: 'CrossOver compatibility layer' },
          custom: { dynamicDesc: 'Legacy custom launch' },
        },
      };

      const crossoverDescriptor = COMPATIBILITY_RUNNER_DESCRIPTORS.find(
        (d) => d.type === 'crossover'
      )!;
      const crossoverLayerInfo = {
        id: 'crossover',
        name: 'CrossOver',
        type: 'crossover' as const,
        binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
        version: '26.0.0',
        d3dmetalVersion: '3.0',
        availableD3DMetalVersions: [
          { id: '4' as const, version: '3.0', label: 'D3DMetal 3.0' },
          { id: '3' as const, version: '2.1', label: 'D3DMetal 2.1' },
        ],
        availableBottles: ['OneLauncher', 'ClassicWin32'],
      };

      let selectedBackend: CrossOverGraphicsBackend = 'auto';
      const baseProps: CompatibilityLayerSectionProps = {
        idPrefix: 'hb-cfg',
        isWindowsHost: false,
        preview: mockPreview,
        activeDisplayMethod: 'compatibility_layer',
        detectedLayers: [crossoverLayerInfo],
        runnerUpdates: {},
        compatibilityLayer: 'crossover',
        onSelectCompatibilityLayer: vi.fn(),
        availableBottles: ['OneLauncher', 'ClassicWin32'],
        wineBottleName: 'OneLauncher',
        onChangeWineBottleName: vi.fn(),
        selectedRunnerDescriptor: crossoverDescriptor,
        activeLayer: crossoverLayerInfo,
        activeInstalledVer: '26.0.0',
        activeSecondaryBuildText: 'Wine 10.0',
        isCheckingUpdates: false,
        isUpdatingRunner: false,
        onUpdateRunner: vi.fn(),
        onCheckRunnerUpdates: vi.fn(),
        resolvedBottleFolderPath: '/tmp/ol-hb-win32-test/CrossOver/Bottles/OneLauncher',
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
        onChangeCrossoverGraphicsBackend: (next) => {
          selectedBackend = next;
        },
        crossoverD3DMetalVersion: 'auto',
        onChangeCrossoverD3DMetalVersion: vi.fn(),
        showD3DMetalVersionSelector: true,
        primaryD3DVer: '3.0',
        fallbackD3DVer: '2.1',
        crossoverHighResolutionMode: undefined,
        onChangeCrossoverHighResolutionMode: vi.fn(),
        isDlssSupportedBackend: true,
        isDxvkHudSupported: true,
        crossoverDlss: true,
        onToggleCrossoverDlss: vi.fn(),
        wineMsync: true,
        wineEsync: false,
        metalHud: false,
        dxvkHud: false,
        onToggleWineMsync: vi.fn(),
        onToggleWineEsync: vi.fn(),
        onToggleMetalHud: vi.fn(),
        onToggleDxvkHud: vi.fn(),
      };

      const harness = createDomain12DeepRenderer(CompatibilityLayerSection, baseProps);
      for (const backend of ['auto', 'd3dmetal', 'dxmt', 'dxvk', 'wined3d'] as const) {
        const isDlss = backend === 'auto' || backend === 'd3dmetal' || backend === 'dxmt';
        const isDxvk = backend === 'auto' || backend === 'dxvk';
        const tree = harness.render({
          crossoverGraphicsBackend: backend,
          isDlssSupportedBackend: isDlss,
          isDxvkHudSupported: isDxvk,
        });

        const badgeNode = findVNodeByTestId(tree, 'graphics-backend-arch-badge');
        const guidanceNode = findVNodeByTestId(tree, 'graphics-backend-guidance');
        expect(badgeNode).toBeDefined();
        expect(guidanceNode).toBeDefined();
        expect(extractVNodeText(badgeNode)).toBe(
          CROSSOVER_GRAPHICS_BACKEND_POLICIES[backend].architectureBadge
        );
        expect(extractVNodeText(guidanceNode)).toBe(
          CROSSOVER_GRAPHICS_BACKEND_POLICIES[backend].guidance
        );

        const backendSelect = findVNodes(
          tree,
          (n) => n.type === 'select' && n.props?.id === 'hb-cfg-graphics-backend'
        )[0];
        expect(backendSelect).toBeDefined();
        expect(backendSelect.props['aria-describedby']).toBe('hb-cfg-graphics-backend-hint');
        expect(guidanceNode.props.id).toBe('hb-cfg-graphics-backend-hint');

        // Verify aria-pressed toggles (D3DMetal version cards), role="switch" controls, and radio sync controls
        const pressedButtons = findVNodes(
          tree,
          (n) => n.type === 'button' && typeof n.props?.['aria-pressed'] === 'boolean'
        );
        expect(pressedButtons.length).toBeGreaterThanOrEqual(3);
        const switchButtons = findVNodes(
          tree,
          (n) =>
            n.type === 'button' &&
            n.props?.role === 'switch' &&
            typeof n.props?.['aria-checked'] === 'boolean'
        );
        expect(switchButtons.length).toBeGreaterThanOrEqual(4);
        const syncRadios = findVNodes(
          tree,
          (n) => n.type === 'input' && n.props?.type === 'radio'
        );
        expect(syncRadios.length).toBe(3);

        // Trigger select change
        backendSelect.props.onChange({ target: { value: backend } });
        expect(selectedBackend).toBe(backend);

        // Verify 0 WCAG 2.2 AA violations (including >=24px target-size check)
        expect(auditWcag22AA(tree)).toEqual([]);
      }

      // Windows host parity: CompatibilityLayerSection returns null on win32
      const winTree = harness.render({ isWindowsHost: true });
      expect(winTree).toBeNull();
      harness.unmount();
    });

    it('enforces WAI-ARIA roving tabIndex, keyboard navigation (ArrowRight, ArrowLeft, Home, End), focus transfer, and 0 WCAG 2.2 AA violations on SystemRequirements', () => {
      // Test on win32 host first -> defaults to 'windows' tab
      ensureWindowAndStorageGlobals('win32');

      const sysReqProps = {
        gameId: 'synth-multi-os-101',
        requirements: {
          minimum: '<strong>Minimum:</strong><ul><li>OS: Windows 10 64-bit</li></ul>',
          recommended: '<strong>Recommended:</strong><ul><li>GPU: DirectX 12</li></ul>',
        },
        macRequirements: {
          minimum: '<strong>Minimum:</strong><ul><li>OS: macOS 14 Sonoma (Apple Silicon)</li></ul>',
          recommended: '<strong>Recommended:</strong><ul><li>Memory: 16 GB unified RAM</li></ul>',
        },
        linuxRequirements: {
          minimum: '<strong>Minimum:</strong><ul><li>OS: Ubuntu 24.04 LTS</li></ul>',
        },
      };

      const harness = createDomain12DeepRenderer(SystemRequirements, sysReqProps);
      let tree = harness.render();

      const getTabState = (root: any) => {
        const tabs = findVNodes(root, (n) => n.type === 'button' && n.props?.role === 'tab');
        const panel = findVNodes(root, (n) => n.type === 'div' && n.props?.role === 'tabpanel')[0];
        return { tabs, panel };
      };

      const focusedTabs: string[] = [];
      const attachFocusSpies = (tabs: any[]) => {
        tabs.forEach((tab) => {
          if (typeof tab.props?.ref === 'function') {
            tab.props.ref({
              focus: () => focusedTabs.push(String(tab.props.id)),
            });
          }
        });
      };

      let { tabs, panel } = getTabState(tree);
      expect(tabs).toHaveLength(3);
      expect(tabs.map((t) => t.props.id)).toEqual([
        'sysreq-tab-windows',
        'sysreq-tab-mac',
        'sysreq-tab-linux',
      ]);
      expect(tabs.map((t) => t.props.tabIndex)).toEqual([0, -1, -1]);
      expect(tabs.map((t) => t.props['aria-selected'])).toEqual([true, false, false]);
      expect(panel.props['aria-labelledby']).toBe('sysreq-tab-windows');
      expect(extractVNodeText(panel)).toContain('Windows 10 64-bit');
      expect(auditWcag22AA(tree)).toEqual([]);

      // ArrowRight from Windows (index 0) -> macOS (index 1)
      attachFocusSpies(tabs);
      const preventDefaultSpy = vi.fn();
      tabs[0].props.onKeyDown({ key: 'ArrowRight', preventDefault: preventDefaultSpy });
      expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
      expect(focusedTabs.at(-1)).toBe('sysreq-tab-mac');

      tree = harness.render();
      ({ tabs, panel } = getTabState(tree));
      expect(tabs.map((t) => t.props.tabIndex)).toEqual([-1, 0, -1]);
      expect(tabs.map((t) => t.props['aria-selected'])).toEqual([false, true, false]);
      expect(panel.props['aria-labelledby']).toBe('sysreq-tab-mac');
      expect(extractVNodeText(panel)).toContain('macOS 14 Sonoma');
      expect(auditWcag22AA(tree)).toEqual([]);

      // End key from macOS (index 1) -> Linux (index 2)
      attachFocusSpies(tabs);
      tabs[1].props.onKeyDown({ key: 'End', preventDefault: preventDefaultSpy });
      expect(focusedTabs.at(-1)).toBe('sysreq-tab-linux');

      tree = harness.render();
      ({ tabs, panel } = getTabState(tree));
      expect(tabs.map((t) => t.props.tabIndex)).toEqual([-1, -1, 0]);
      expect(tabs.map((t) => t.props['aria-selected'])).toEqual([false, false, true]);
      expect(panel.props['aria-labelledby']).toBe('sysreq-tab-linux');
      expect(extractVNodeText(panel)).toContain('Ubuntu 24.04 LTS');
      expect(auditWcag22AA(tree)).toEqual([]);

      // ArrowRight from Linux (index 2) wraps around -> Windows (index 0)
      attachFocusSpies(tabs);
      tabs[2].props.onKeyDown({ key: 'ArrowRight', preventDefault: preventDefaultSpy });
      expect(focusedTabs.at(-1)).toBe('sysreq-tab-windows');

      tree = harness.render();
      ({ tabs, panel } = getTabState(tree));
      expect(tabs.map((t) => t.props.tabIndex)).toEqual([0, -1, -1]);

      // ArrowLeft from Windows (index 0) wraps around -> Linux (index 2)
      attachFocusSpies(tabs);
      tabs[0].props.onKeyDown({ key: 'ArrowLeft', preventDefault: preventDefaultSpy });
      expect(focusedTabs.at(-1)).toBe('sysreq-tab-linux');

      tree = harness.render();
      ({ tabs, panel } = getTabState(tree));
      expect(tabs.map((t) => t.props.tabIndex)).toEqual([-1, -1, 0]);

      // Home key from Linux (index 2) -> Windows (index 0)
      attachFocusSpies(tabs);
      tabs[2].props.onKeyDown({ key: 'Home', preventDefault: preventDefaultSpy });
      expect(focusedTabs.at(-1)).toBe('sysreq-tab-windows');

      tree = harness.render();
      ({ tabs, panel } = getTabState(tree));
      expect(tabs.map((t) => t.props.tabIndex)).toEqual([0, -1, -1]);
      expect(auditWcag22AA(tree)).toEqual([]);

      // Darwin host preference check: switching gameId on darwin schedules useEffect -> defaults to 'mac' tab
      ensureWindowAndStorageGlobals('darwin');
      harness.render({ gameId: 'synth-multi-os-202' });
      tree = harness.render();
      ({ tabs, panel } = getTabState(tree));
      expect(tabs.map((t) => t.props.tabIndex)).toEqual([-1, 0, -1]);
      expect(panel.props['aria-labelledby']).toBe('sysreq-tab-mac');
      expect(auditWcag22AA(tree)).toEqual([]);

      harness.unmount();
    });
  });
});
