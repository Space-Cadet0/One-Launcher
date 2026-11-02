import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import type { DownloadTaskState } from '../src/contracts/launcher';
import { launcherService } from '../src/services/launcher/launcherService';
import { DownloadManagerDrawer } from '../src/components/Launcher/DownloadManagerDrawer';

const requireCjs = createRequire(import.meta.url);
const launcherEngine = requireCjs('../electron/launcherEngine.cjs');
const engineState = requireCjs('../electron/launcher/engineStateRegistry.cjs');
const gogDirect = requireCjs('../electron/launcher/gogRegistryAndDirectInstaller.cjs');
const macInstaller = requireCjs('../electron/launcher/macNativeInstallerAndCodesign.cjs');

// ---------------------------------------------------------------------------
// Headless Browser Environment Polyfills (Hermetic, Zero PII)
// ---------------------------------------------------------------------------
class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

const mockStorage = new MockStorage();

if (typeof (globalThis as Record<string, unknown>).localStorage === 'undefined') {
  (globalThis as Record<string, unknown>).localStorage = mockStorage;
}
if (typeof (globalThis as Record<string, unknown>).requestAnimationFrame === 'undefined') {
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
}

const eventTarget = new EventTarget();

if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: Event) => eventTarget.dispatchEvent(event),
    localStorage: mockStorage,
    location: { hostname: 'example.com' },
    innerWidth: 1440,
    innerHeight: 900,
    electronAPI: { platform: 'darwin' },
  };
}

if (typeof (globalThis as Record<string, unknown>).document === 'undefined') {
  (globalThis as Record<string, unknown>).document = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.removeEventListener(type, listener),
    body: {},
  };
}

// ---------------------------------------------------------------------------
// Lightweight React 19 Component Harness (Matches Repository Pattern)
// ---------------------------------------------------------------------------
function getTextContent(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return getTextContent(props?.children);
  }
  return '';
}

function createComponentHarness<P extends object>(Component: React.FC<P>, initialProps: P) {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const prevDeps: Array<unknown[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  let currentProps = initialProps;

  const render = (nextProps?: Partial<P>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    const pendingEffects: Array<{ idx: number; fn: () => unknown }> = [];

    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    const runEffectHook = (fn: () => unknown, deps?: unknown[]) => {
      const idx = effectIdx++;
      const oldDeps = prevDeps[idx];
      const changed =
        !oldDeps ||
        !deps ||
        oldDeps.length !== deps.length ||
        deps.some((d, i) => !Object.is(d, oldDeps[i]));
      if (changed) {
        prevDeps[idx] = deps;
        pendingEffects.push({ idx, fn });
      }
    };

    internals.H = {
      useState(initial: unknown) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        const setState = (updater: unknown) => {
          states[idx] =
            typeof updater === 'function'
              ? (updater as (prev: unknown) => unknown)(states[idx])
              : updater;
        };
        return [states[idx], setState];
      },
      useRef(initial: unknown) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useEffect: runEffectHook,
      useLayoutEffect: runEffectHook,
      useMemo(fn: () => unknown) {
        return fn();
      },
      useCallback(fn: unknown) {
        return fn;
      },
      useDeferredValue(val: unknown) {
        return val;
      },
      useTransition() {
        return [false, (fn: () => void) => fn()];
      },
      useContext(ctx: { _currentValue?: unknown }) {
        return ctx._currentValue;
      },
      useId() {
        return 'synthetic-id';
      },
    };

    let tree: unknown;
    try {
      tree = Component(currentProps);
    } finally {
      internals.H = prevH;
    }

    for (const eff of pendingEffects) {
      if (typeof cleanups[eff.idx] === 'function') {
        cleanups[eff.idx]!();
      }
      const cleanup = eff.fn();
      cleanups[eff.idx] = typeof cleanup === 'function' ? (cleanup as () => void) : undefined;
    }

    return tree;
  };

  const unmount = () => {
    for (const c of cleanups) {
      if (typeof c === 'function') c();
    }
  };

  return { render, unmount };
}

// ---------------------------------------------------------------------------
// Synthetic GOG V2 Manifest & Zlib Chunk Fixture Builders (Zero PII)
// ---------------------------------------------------------------------------
const SYNTHETIC_GAME_ID = '9900112233';
const SYNTHETIC_DLC_ID = '9900112299';
const SYNTHETIC_TITLE = 'Synthetic Arena II';
const SYNTHETIC_NESTED_FOLDER = 'Synthetic Arena II Enhanced';

function md5Hex(buf: Buffer): string {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function makePeBinaryBuffer(label: string, repeatCount = 64): Buffer {
  const header = Buffer.alloc(64, 0);
  header.write('MZ', 0, 'ascii');
  const body = Buffer.from(`SYNTHETIC_PE_${label}_`.repeat(repeatCount), 'utf8');
  return Buffer.concat([header, body]);
}

function makeMachOBinaryBuffer(label: string, repeatCount = 64): Buffer {
  const header = Buffer.alloc(32, 0);
  // 64-bit Mach-O magic 0xFEEDFACF (little-endian)
  header.writeUInt32LE(0xfeedfacf, 0);
  const body = Buffer.from(`SYNTHETIC_MACHO_${label}_`.repeat(repeatCount), 'utf8');
  return Buffer.concat([header, body]);
}

interface SyntheticChunkEntry {
  compressedMd5: string;
  md5: string;
  size: number;
  compressedSize: number;
  rawBuffer: Buffer;
  compressedBuffer: Buffer;
}

function makeCompressedChunk(rawBuffer: Buffer): SyntheticChunkEntry {
  const compressedBuffer = zlib.deflateSync(rawBuffer, { level: 6 });
  return {
    compressedMd5: md5Hex(compressedBuffer),
    md5: md5Hex(rawBuffer),
    size: rawBuffer.length,
    compressedSize: compressedBuffer.length,
    rawBuffer,
    compressedBuffer,
  };
}

function makeDeflatedJsonResponse(payload: unknown, status = 200) {
  const deflated = zlib.deflateSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () =>
      deflated.buffer.slice(deflated.byteOffset, deflated.byteOffset + deflated.byteLength),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function makeJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => {
      const buf = Buffer.from(JSON.stringify(payload), 'utf8');
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

function makeBinaryResponse(buf: Buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => ({}),
    text: async () => '',
  };
}

interface MockGogV2CdnRig {
  fetchImpl: ReturnType<typeof vi.fn>;
  chunkFetchCounts: Map<string, number>;
  expectedPakBuffer: Buffer;
  expectedIniBuffer: Buffer;
  expectedAudioBuffer: Buffer;
  expectedExeBuffer: Buffer;
  expectedDosboxBuffer: Buffer;
  expectedBaseCompressedBytes: number;
  expectedBaseUncompressedBytes: number;
  expectedCompressedBasePlusDepBytes: number;
  expectedUncompressedBasePlusDepBytes: number;
  expectedDlcCompressedBytes: number;
  expectedDlcUncompressedBytes: number;
  chunkMap: Map<string, Buffer>;
}

function buildSyntheticGogV2CdnRig(opts?: {
  gogOs?: 'windows' | 'osx';
  tamperChunkHash?: string;
  requireTokenRefreshOnFirstSecureLink?: boolean;
  requireTokenRefreshOnFirstChunk?: boolean;
  failFastlyEndpointWith503?: boolean;
  onBeforeChunkFetch?: (compressedMd5: string, callIndex: number) => Promise<void> | void;
}): MockGogV2CdnRig {
  const gogOs = opts?.gogOs || 'windows';
  const chunkMap = new Map<string, Buffer>();
  const chunkFetchCounts = new Map<string, number>();

  // Multi-chunk large asset (highly compressible so uncompressed > compressed)
  const pakPart0 = Buffer.from('PAK0_SEGMENT_ALPHA_'.repeat(320), 'utf8');
  const pakPart1 = Buffer.from('PAK0_SEGMENT_BETA__'.repeat(260), 'utf8');
  const expectedPakBuffer = Buffer.concat([pakPart0, pakPart1]);
  const pakChunk0 = makeCompressedChunk(pakPart0);
  const pakChunk1 = makeCompressedChunk(pakPart1);
  chunkMap.set(pakChunk0.compressedMd5, pakChunk0.compressedBuffer);
  chunkMap.set(pakChunk1.compressedMd5, pakChunk1.compressedBuffer);

  // SmallFilesContainer packing 2 sfcRef small files
  const expectedIniBuffer = Buffer.from('[Display]\nFullscreen=1\nWidth=1920\nHeight=1080\n', 'utf8');
  const expectedAudioBuffer = Buffer.from('OggS_SYNTHETIC_TRACK01_STREAM_'.repeat(30), 'utf8');
  const sfcCombined = Buffer.concat([expectedIniBuffer, expectedAudioBuffer]);
  const sfcChunk = makeCompressedChunk(sfcCombined);
  chunkMap.set(sfcChunk.compressedMd5, sfcChunk.compressedBuffer);

  // Primary executable (Windows PE or macOS Mach-O inside .app)
  const expectedExeBuffer =
    gogOs === 'osx'
      ? makeMachOBinaryBuffer('ARENA_MAC', 80)
      : makePeBinaryBuffer('ARENA_WIN', 80);
  const exeChunk = makeCompressedChunk(expectedExeBuffer);
  chunkMap.set(exeChunk.compressedMd5, exeChunk.compressedBuffer);

  // Info.plist for macOS .app bundle
  const plistBuffer = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>SyntheticArena</string>
  <key>CFBundleIdentifier</key><string>com.example.syntheticarena2</string>
  <key>CFBundleName</key><string>Synthetic Arena II Enhanced</string>
</dict></plist>`,
    'utf8'
  );
  const plistChunk = makeCompressedChunk(plistBuffer);
  chunkMap.set(plistChunk.compressedMd5, plistChunk.compressedBuffer);

  // Shared V2 runtime dependency: DOSBox (required) vs MSVC2019_x64 (__redist, skipped)
  const expectedDosboxBuffer = makePeBinaryBuffer('DOSBOX_RUNTIME', 40);
  const dosboxChunk = makeCompressedChunk(expectedDosboxBuffer);
  chunkMap.set(dosboxChunk.compressedMd5, dosboxChunk.compressedBuffer);

  const redistBuffer = makePeBinaryBuffer('MSVC_REDIST_SKIP', 50);
  const redistChunk = makeCompressedChunk(redistBuffer);
  chunkMap.set(redistChunk.compressedMd5, redistChunk.compressedBuffer);

  // Optional DLC depot chunk (for size calculation accuracy)
  const dlcBuffer = Buffer.from('SYNTHETIC_DLC_EXPANSION_PAK_'.repeat(200), 'utf8');
  const dlcChunk = makeCompressedChunk(dlcBuffer);
  chunkMap.set(dlcChunk.compressedMd5, dlcChunk.compressedBuffer);

  const baseDepotManifest =
    gogOs === 'osx'
      ? {
          depot: {
            smallFilesContainer: {
              chunks: [
                {
                  compressedMd5: sfcChunk.compressedMd5,
                  md5: sfcChunk.md5,
                  size: sfcChunk.size,
                  compressedSize: sfcChunk.compressedSize,
                },
              ],
            },
            items: [
              {
                type: 'DepotFile',
                path: 'Contents/Info.plist',
                chunks: [
                  {
                    compressedMd5: plistChunk.compressedMd5,
                    md5: plistChunk.md5,
                    size: plistChunk.size,
                    compressedSize: plistChunk.compressedSize,
                  },
                ],
              },
              {
                type: 'DepotFile',
                path: 'Contents/MacOS/SyntheticArena',
                flags: ['executable'],
                chunks: [
                  {
                    compressedMd5: exeChunk.compressedMd5,
                    md5: exeChunk.md5,
                    size: exeChunk.size,
                    compressedSize: exeChunk.compressedSize,
                  },
                ],
              },
              {
                type: 'DepotFile',
                path: 'Contents/Resources/base/pak0.pak',
                md5: md5Hex(expectedPakBuffer),
                chunks: [
                  {
                    compressedMd5: pakChunk0.compressedMd5,
                    md5: pakChunk0.md5,
                    size: pakChunk0.size,
                    compressedSize: pakChunk0.compressedSize,
                  },
                  {
                    compressedMd5: pakChunk1.compressedMd5,
                    md5: pakChunk1.md5,
                    size: pakChunk1.size,
                    compressedSize: pakChunk1.compressedSize,
                  },
                ],
              },
              {
                type: 'DepotFile',
                path: 'Contents/Resources/config/settings.ini',
                sfcRef: { offset: 0, size: expectedIniBuffer.length },
              },
              {
                type: 'DepotFile',
                path: 'Contents/Resources/base/music/track01.ogg',
                sfcRef: { offset: expectedIniBuffer.length, size: expectedAudioBuffer.length },
              },
            ],
          },
        }
      : {
          depot: {
            smallFilesContainer: {
              chunks: [
                {
                  compressedMd5: sfcChunk.compressedMd5,
                  md5: sfcChunk.md5,
                  size: sfcChunk.size,
                  compressedSize: sfcChunk.compressedSize,
                },
              ],
            },
            items: [
              {
                type: 'DepotFile',
                path: 'game_gog.exe',
                flags: ['executable'],
                chunks: [
                  {
                    compressedMd5: exeChunk.compressedMd5,
                    md5: exeChunk.md5,
                    size: exeChunk.size,
                    compressedSize: exeChunk.compressedSize,
                  },
                ],
              },
              {
                type: 'DepotFile',
                path: 'base\\pak0.pak',
                md5: md5Hex(expectedPakBuffer),
                chunks: [
                  {
                    compressedMd5: pakChunk0.compressedMd5,
                    md5: pakChunk0.md5,
                    size: pakChunk0.size,
                    compressedSize: pakChunk0.compressedSize,
                  },
                  {
                    compressedMd5: pakChunk1.compressedMd5,
                    md5: pakChunk1.md5,
                    size: pakChunk1.size,
                    compressedSize: pakChunk1.compressedSize,
                  },
                ],
              },
              {
                type: 'DepotFile',
                path: 'config\\settings.ini',
                sfcRef: { offset: 0, size: expectedIniBuffer.length },
              },
              {
                type: 'DepotFile',
                path: 'base\\music\\track01.ogg',
                sfcRef: { offset: expectedIniBuffer.length, size: expectedAudioBuffer.length },
              },
            ],
          },
        };

  const dlcDepotManifest = {
    depot: {
      items: [
        {
          type: 'DepotFile',
          path: 'dlc\\expansion01.pak',
          chunks: [
            {
              compressedMd5: dlcChunk.compressedMd5,
              md5: dlcChunk.md5,
              size: dlcChunk.size,
              compressedSize: dlcChunk.compressedSize,
            },
          ],
        },
      ],
    },
  };

  const dosboxDepManifest = {
    depot: {
      items: [
        {
          type: 'DepotFile',
          path: 'DOSBox\\DOSBox.exe',
          chunks: [
            {
              compressedMd5: dosboxChunk.compressedMd5,
              md5: dosboxChunk.md5,
              size: dosboxChunk.size,
              compressedSize: dosboxChunk.compressedSize,
            },
          ],
        },
      ],
    },
  };

  const redistDepManifest = {
    depot: {
      items: [
        {
          type: 'DepotFile',
          path: '__redist\\MSVC2019_x64.exe',
          chunks: [
            {
              compressedMd5: redistChunk.compressedMd5,
              md5: redistChunk.md5,
              size: redistChunk.size,
              compressedSize: redistChunk.compressedSize,
            },
          ],
        },
      ],
    },
  };

  const baseCompressedSize =
    sfcChunk.compressedSize +
    exeChunk.compressedSize +
    pakChunk0.compressedSize +
    pakChunk1.compressedSize +
    (gogOs === 'osx' ? plistChunk.compressedSize : 0);
  const baseUncompressedSize =
    expectedIniBuffer.length +
    expectedAudioBuffer.length +
    expectedExeBuffer.length +
    expectedPakBuffer.length +
    (gogOs === 'osx' ? plistBuffer.length : 0);

  const metaPayload = {
    version: 2,
    productId: SYNTHETIC_GAME_ID,
    baseProductId: SYNTHETIC_GAME_ID,
    clientId: 'synthetic_gog_client_99',
    installDirectory:
      gogOs === 'osx' ? `${SYNTHETIC_NESTED_FOLDER}.app` : SYNTHETIC_NESTED_FOLDER,
    dependencies: gogOs === 'windows' ? ['DOSBox', 'MSVC2019_x64'] : [],
    depots: [
      {
        productId: SYNTHETIC_GAME_ID,
        languages: ['en-US', '*'],
        manifest: 'base_depot_manifest_9900',
        compressedSize: baseCompressedSize,
        size: baseUncompressedSize,
      },
      {
        productId: SYNTHETIC_DLC_ID,
        languages: ['en-US'],
        manifest: 'dlc_depot_manifest_9900',
        compressedSize: dlcChunk.compressedSize,
        size: dlcChunk.size,
      },
    ],
    products: [
      { productId: SYNTHETIC_GAME_ID, name: SYNTHETIC_TITLE },
      { productId: SYNTHETIC_DLC_ID, name: 'Synthetic Arena II - Expansion Pack' },
    ],
    scriptInterpreter: false,
    playTasks:
      gogOs === 'osx'
        ? [
            {
              isPrimary: true,
              type: 'FileTask',
              category: 'game',
              name: SYNTHETIC_TITLE,
              path: 'Contents/MacOS/SyntheticArena',
            },
          ]
        : [
            {
              isPrimary: true,
              type: 'FileTask',
              category: 'game',
              name: SYNTHETIC_TITLE,
              path: 'DOSBox\\DOSBox.exe',
              arguments: '-conf dosbox_arena.conf',
              workingDir: 'DOSBox',
            },
          ],
  };

  const depRepoMeta = {
    depots: [
      {
        dependencyId: 'DOSBox',
        manifest: 'dep_dosbox_manifest_9900',
        compressedSize: dosboxChunk.compressedSize,
        size: dosboxChunk.size,
        executable: { path: 'DOSBox/DOSBox.exe' },
      },
      {
        dependencyId: 'MSVC2019_x64',
        manifest: 'dep_redist_manifest_9900',
        compressedSize: redistChunk.compressedSize,
        size: redistChunk.size,
        executable: { path: '__redist/MSVC2019_x64.exe' },
      },
    ],
  };

  let firstChunkAuthFailed = false;
  let totalChunkCalls = 0;

  const fetchImpl = vi.fn(async (urlInput: string | URL, init?: RequestInit) => {
    const url = String(urlInput);
    const signal = init?.signal;
    if (signal?.aborted) {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    if (url.includes(`/products/${SYNTHETIC_GAME_ID}/os/${gogOs}/builds?generation=2`)) {
      return makeJsonResponse({
        total_count: 1,
        items: [
          {
            build_id: '55009911',
            product_id: SYNTHETIC_GAME_ID,
            os: gogOs,
            generation: 2,
            version_name: '2.4.0-gog',
            link: 'https://cdn.gog.com/content-system/v2/meta/aa/bb/aabbccdd00112233445566778899aabb',
          },
        ],
      });
    }

    if (url.includes('/content-system/v2/meta/aa/bb/aabbccdd00112233445566778899aabb')) {
      return makeDeflatedJsonResponse(metaPayload);
    }

    if (url.includes('/content-system/v2/meta/') && url.includes('base_depot_manifest_9900')) {
      return makeDeflatedJsonResponse(baseDepotManifest);
    }
    if (url.includes('/content-system/v2/meta/') && url.includes('dlc_depot_manifest_9900')) {
      return makeDeflatedJsonResponse(dlcDepotManifest);
    }

    if (url.includes('/dependencies/repository?generation=2')) {
      return makeJsonResponse({
        repository_manifest:
          'https://cdn.gog.com/content-system/v2/dependencies/meta/11/22/dep_repo_meta_9900',
      });
    }
    if (url.includes('dep_repo_meta_9900')) {
      return makeDeflatedJsonResponse(depRepoMeta);
    }
    if (url.includes('dep_dosbox_manifest_9900')) {
      return makeDeflatedJsonResponse(dosboxDepManifest);
    }
    if (url.includes('dep_redist_manifest_9900')) {
      return makeDeflatedJsonResponse(redistDepManifest);
    }

    if (url.includes('/secure_link?')) {
      const authHeader = String(
        (init?.headers as Record<string, string> | undefined)?.Authorization || ''
      );
      if (opts?.requireTokenRefreshOnFirstSecureLink && authHeader.includes('expired_token')) {
        return makeJsonResponse({ error: 'unauthorized' }, 401);
      }
      const isRefreshed = authHeader.includes('refreshed_token');
      return makeJsonResponse({
        urls: [
          {
            endpoint_name: 'fastly',
            url_format: '{base_url}/token={token}/{path}',
            parameters: {
              base_url: 'https://gog-cdn-fastly.gog.com',
              token: isRefreshed ? 'fresh_cdn_sig' : 'initial_cdn_sig',
              path: 'content-system/v2/store',
            },
            priority: 100,
          },
          {
            endpoint_name: 'gcore',
            url_format: '{base_url}/{path}?wsSecret={token}&wsTime={time}&prefix={prefix}',
            parameters: {
              base_url: 'https://gcore.gog.com',
              path: 'store',
              token: isRefreshed ? 'fresh_gcore_sig' : 'initial_gcore_sig',
              time: 1700000000,
              prefix: 'edge1',
            },
            priority: 80,
          },
        ],
      });
    }

    if (url.includes('/open_link?')) {
      return makeJsonResponse({
        urls: [
          {
            endpoint_name: 'open_fastly',
            url_format: 'https://gog-cdn-open.gog.com/open/dependencies/store',
            parameters: {},
            priority: 100,
          },
        ],
      });
    }

    // Store chunk download match: /<2>/<2>/<32-hex>(?query|$)
    const hashMatch = url.match(/\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{32})(?:\?|$)/i);
    if (hashMatch) {
      const hash = hashMatch[1].toLowerCase();
      if (opts?.failFastlyEndpointWith503 && url.includes('gog-cdn-fastly.gog.com')) {
        return makeBinaryResponse(Buffer.alloc(0), 503);
      }
      if (opts?.requireTokenRefreshOnFirstChunk && url.includes('initial_')) {
        firstChunkAuthFailed = true;
        return makeBinaryResponse(Buffer.alloc(0), 401);
      }

      const prevCount = chunkFetchCounts.get(hash) || 0;
      chunkFetchCounts.set(hash, prevCount + 1);
      const callIdx = ++totalChunkCalls;

      if (opts?.onBeforeChunkFetch) {
        await opts.onBeforeChunkFetch(hash, callIdx);
      }
      if (signal?.aborted) {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      const rawCompressed = chunkMap.get(hash);
      if (!rawCompressed) {
        return makeBinaryResponse(Buffer.alloc(0), 404);
      }
      if (opts?.tamperChunkHash && opts.tamperChunkHash.toLowerCase() === hash) {
        const corrupted = Buffer.from(rawCompressed);
        corrupted[corrupted.length - 1] ^= 0xff;
        return makeBinaryResponse(corrupted, 200);
      }
      return makeBinaryResponse(rawCompressed, 200);
    }

    return makeJsonResponse({ error: `Unhandled synthetic URL: ${url}` }, 404);
  });

  const expectedCompressedBasePlusDepBytes =
    baseCompressedSize + (gogOs === 'windows' ? dosboxChunk.compressedSize : 0);
  const expectedUncompressedBasePlusDepBytes =
    baseUncompressedSize + (gogOs === 'windows' ? dosboxChunk.size : 0);
  void firstChunkAuthFailed;

  return {
    fetchImpl,
    chunkFetchCounts,
    expectedPakBuffer,
    expectedIniBuffer,
    expectedAudioBuffer,
    expectedExeBuffer,
    expectedDosboxBuffer,
    expectedBaseCompressedBytes: baseCompressedSize,
    expectedBaseUncompressedBytes: baseUncompressedSize,
    expectedCompressedBasePlusDepBytes,
    expectedUncompressedBasePlusDepBytes,
    expectedDlcCompressedBytes: dlcChunk.compressedSize,
    expectedDlcUncompressedBytes: dlcChunk.size,
    chunkMap,
  };
}

// ---------------------------------------------------------------------------
// Test Lifecycle & Hermetic Temp Sandbox
// ---------------------------------------------------------------------------
describe('GOG V2 Bottled Install, Scanner Race & Telemetry Regression Suite (macOS & Windows)', () => {
  let tmpRoot = '';
  let homedir = '';
  let userDataDir = '';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-gog-v2-reg-'));
    homedir = path.join(tmpRoot, 'home');
    userDataDir = path.join(tmpRoot, 'userdata');
    fs.mkdirSync(homedir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    engineState.setUserDataDir(userDataDir);
    launcherEngine.clearDownloadQueue({ userDataDir });
    engineState.invalidateScanCaches();
    mockStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      launcherEngine.clearDownloadQueue({ userDataDir });
      engineState.invalidateScanCaches();
      engineState.setUserDataDir(null);
    } catch {
      // Ignore teardown cleanup errors
    }
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. Mid-Download Scanner Non-Interference (darwin & win32)
  // =========================================================================
  describe('1. Mid-Download Scanner Non-Interference (darwin & win32)', () => {
    it('prevents premature flattening, premature GOG record emission, and .exe chmodSync during active downloadQueueMap tasks', () => {
      const gogRoot = path.join(tmpRoot, 'Library', 'GOG');
      const gameDir = path.join(gogRoot, SYNTHETIC_TITLE);
      const nestedDir = path.join(gameDir, SYNTHETIC_NESTED_FOLDER);
      fs.mkdirSync(nestedDir, { recursive: true });

      const nestedExePath = path.join(nestedDir, 'game_gog.exe');
      fs.writeFileSync(nestedExePath, makePeBinaryBuffer('IN_FLIGHT_EXE', 16));
      fs.writeFileSync(
        path.join(nestedDir, `goggame-${SYNTHETIC_GAME_ID}.info`),
        JSON.stringify({
          gameId: SYNTHETIC_GAME_ID,
          name: SYNTHETIC_TITLE,
          playTasks: [{ isPrimary: true, category: 'game', path: 'game_gog.exe' }],
        }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(nestedDir, '.onelauncher-gog-v2-resume.json'),
        JSON.stringify({ schemaVersion: 1, productId: SYNTHETIC_GAME_ID }),
        'utf8'
      );

      // Register active downloading task in downloadQueueMap
      const taskId = `dl-gog-${SYNTHETIC_GAME_ID}`;
      engineState.downloadQueueMap.set(taskId, {
        taskId,
        gameId: `gog-${SYNTHETIC_GAME_ID}`,
        platformId: 'gog',
        platformGameId: SYNTHETIC_GAME_ID,
        title: SYNTHETIC_TITLE,
        status: 'downloading',
        finalInstallPath: gameDir,
      });

      expect(engineState.isPathUnderActiveDownload(gameDir)).toBe(true);
      expect(engineState.isPathUnderActiveDownload(nestedDir)).toBe(true);
      expect(
        engineState.isPathOrGameUnderIncompleteDownload(nestedDir, 'gog', SYNTHETIC_GAME_ID)
      ).toBe(true);

      const chmodSpy = vi.spyOn(fs, 'chmodSync');

      for (const targetPlatform of ['darwin', 'win32'] as const) {
        engineState.invalidateScanCaches();
        const scanned = launcherEngine.scanAllInstalledGames({
          platform: targetPlatform,
          homedir,
          userDataDir,
          customRoots: [gogRoot],
          forceRefresh: true,
        });

        const prematureGog = scanned.installedGames.filter(
          (g: { platformId?: string; platformGameId?: string }) =>
            g.platformId === 'gog' && String(g.platformGameId) === SYNTHETIC_GAME_ID
        );
        expect(prematureGog).toHaveLength(0);
        // Nested folder and files must NOT be flattened mid-download
        expect(fs.existsSync(nestedExePath)).toBe(true);
        expect(fs.existsSync(path.join(gameDir, 'game_gog.exe'))).toBe(false);
      }

      // Verify Windows .exe was never touched by chmodSync on macOS
      const exeChmodCalls = chmodSpy.mock.calls.filter(([filePath]) =>
        String(filePath).toLowerCase().endsWith('.exe')
      );
      expect(exeChmodCalls).toHaveLength(0);
    });

    it('respects .gogdl-resume and .gogdl-download-cache markers even when downloadQueueMap is empty, and skips .exe chmod in findPrimaryExecutable', () => {
      for (const markerName of ['.gogdl-resume', '.gogdl-download-cache'] as const) {
        const gogRoot = path.join(tmpRoot, `Markers_${markerName.replace(/\W+/g, '_')}`, 'GOG');
        const gameDir = path.join(gogRoot, SYNTHETIC_TITLE);
        const nestedDir = path.join(gameDir, SYNTHETIC_NESTED_FOLDER);
        fs.mkdirSync(nestedDir, { recursive: true });

        const exePath = path.join(nestedDir, 'game_gog.exe');
        fs.writeFileSync(exePath, makePeBinaryBuffer('MARKER_GUARD', 12));
        fs.writeFileSync(
          path.join(nestedDir, `goggame-${SYNTHETIC_GAME_ID}.info`),
          JSON.stringify({
            gameId: SYNTHETIC_GAME_ID,
            name: SYNTHETIC_TITLE,
            playTasks: [{ isPrimary: true, category: 'game', path: 'game_gog.exe' }],
          }),
          'utf8'
        );

        if (markerName === '.gogdl-download-cache') {
          fs.mkdirSync(path.join(nestedDir, markerName), { recursive: true });
        } else {
          fs.writeFileSync(path.join(nestedDir, markerName), 'resume_state', 'utf8');
        }

        // Direct flatten call must bail out without moving nested files
        macInstaller.flattenGogNestedInstallDir(gameDir, SYNTHETIC_GAME_ID);
        expect(fs.existsSync(exePath)).toBe(true);
        expect(fs.existsSync(path.join(gameDir, 'game_gog.exe'))).toBe(false);

        for (const targetPlatform of ['darwin', 'win32'] as const) {
          engineState.invalidateScanCaches();
          const scanned = launcherEngine.scanAllInstalledGames({
            platform: targetPlatform,
            homedir,
            userDataDir,
            customRoots: [gogRoot],
            forceRefresh: true,
          });
          expect(
            scanned.installedGames.filter(
              (g: { platformId?: string; platformGameId?: string }) =>
                g.platformId === 'gog' && String(g.platformGameId) === SYNTHETIC_GAME_ID
            )
          ).toHaveLength(0);
        }

        // Verify findPrimaryExecutable on darwin with preferWindowsExecutable / readOnly never calls chmodSync on .exe
        const chmodSpy = vi.spyOn(fs, 'chmodSync');
        const found = macInstaller.findPrimaryExecutable(nestedDir, {
          platform: 'darwin',
          hintName: SYNTHETIC_TITLE,
          preferWindowsExecutable: true,
          readOnly: false,
        });
        expect(found.executablePath).toBe(exePath);
        const exeChmods = chmodSpy.mock.calls.filter(([p]) =>
          String(p).toLowerCase().endsWith('.exe')
        );
        expect(exeChmods).toHaveLength(0);
        chmodSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // 2. Recursive Merge Self-Healing of Split/Torn GOG Directories
  // =========================================================================
  describe('2. Recursive Merge Self-Healing of Split/Torn GOG Directories', () => {
    it('recursively merges colliding subdirectories, refreshes goggame-<id>.info, and removes stale .gogdl-resume & nested folder', () => {
      const gogRoot = path.join(tmpRoot, 'SelfHealLibrary', 'GOG');
      const gameDir = path.join(gogRoot, SYNTHETIC_TITLE);
      const nestedDir = path.join(gameDir, SYNTHETIC_NESTED_FOLDER);

      // Torn outer files from an interrupted prior race
      fs.mkdirSync(path.join(gameDir, 'base'), { recursive: true });
      fs.writeFileSync(path.join(gameDir, 'base', 'pak0.pak'), 'OUTER_PAK0_PAYLOAD', 'utf8');
      fs.writeFileSync(path.join(gameDir, '.gogdl-resume'), 'stale_root_resume_marker', 'utf8');
      fs.writeFileSync(
        path.join(gameDir, `goggame-${SYNTHETIC_GAME_ID}.info`),
        JSON.stringify({ gameId: SYNTHETIC_GAME_ID, name: SYNTHETIC_TITLE }),
        'utf8'
      );

      // Remaining inner files & deeper colliding subdirectories inside nested installDirectory
      fs.mkdirSync(path.join(nestedDir, 'base', 'music'), { recursive: true });
      fs.mkdirSync(path.join(nestedDir, 'base', 'video'), { recursive: true });
      fs.writeFileSync(
        path.join(nestedDir, 'base', 'music', 'track01.ogg'),
        'INNER_MUSIC_TRACK01',
        'utf8'
      );
      fs.writeFileSync(
        path.join(nestedDir, 'base', 'video', 'intro.ogv'),
        'INNER_VIDEO_INTRO',
        'utf8'
      );
      const exeBuf = makePeBinaryBuffer('SELF_HEALED_EXE', 20);
      fs.writeFileSync(path.join(nestedDir, 'game_gog.exe'), exeBuf);
      fs.writeFileSync(
        path.join(nestedDir, `goggame-${SYNTHETIC_GAME_ID}.info`),
        JSON.stringify({
          gameId: SYNTHETIC_GAME_ID,
          name: SYNTHETIC_TITLE,
          buildId: '55009911',
          playTasks: [
            {
              isPrimary: true,
              type: 'FileTask',
              category: 'game',
              name: SYNTHETIC_TITLE,
              path: 'game_gog.exe',
            },
          ],
        }),
        'utf8'
      );

      const healedPath = macInstaller.flattenGogNestedInstallDir(gameDir, SYNTHETIC_GAME_ID);
      expect(healedPath).toBe(gameDir);

      // Every asset from both outer and inner trees must coexist intact under <GameDir>
      expect(fs.readFileSync(path.join(gameDir, 'base', 'pak0.pak'), 'utf8')).toBe(
        'OUTER_PAK0_PAYLOAD'
      );
      expect(fs.readFileSync(path.join(gameDir, 'base', 'music', 'track01.ogg'), 'utf8')).toBe(
        'INNER_MUSIC_TRACK01'
      );
      expect(fs.readFileSync(path.join(gameDir, 'base', 'video', 'intro.ogv'), 'utf8')).toBe(
        'INNER_VIDEO_INTRO'
      );
      expect(fs.readFileSync(path.join(gameDir, 'game_gog.exe')).equals(exeBuf)).toBe(true);

      // Root goggame-<id>.info must be refreshed with playTasks from nested .info
      const mergedInfo = JSON.parse(
        fs.readFileSync(path.join(gameDir, `goggame-${SYNTHETIC_GAME_ID}.info`), 'utf8')
      );
      expect(mergedInfo.buildId).toBe('55009911');
      expect(mergedInfo.playTasks?.[0]?.path).toBe('game_gog.exe');

      // Stale root .gogdl-resume and empty nested folder must be purged
      expect(fs.existsSync(path.join(gameDir, '.gogdl-resume'))).toBe(false);
      expect(fs.existsSync(nestedDir)).toBe(false);

      // Scanner on both darwin and win32 cleanly discovers the healed flat directory
      for (const targetPlatform of ['darwin', 'win32'] as const) {
        engineState.invalidateScanCaches();
        const scanned = launcherEngine.scanAllInstalledGames({
          platform: targetPlatform,
          homedir,
          userDataDir,
          customRoots: [gogRoot],
          forceRefresh: true,
        });
        const match = scanned.installedGames.find(
          (g: { platformId?: string; platformGameId?: string }) =>
            g.platformId === 'gog' && String(g.platformGameId) === SYNTHETIC_GAME_ID
        );
        expect(match).toBeDefined();
        expect(match.installPath).toBe(gameDir);
        expect(match.executablePath).toBe(path.join(gameDir, 'game_gog.exe'));
      }
    });
  });

  // =========================================================================
  // 3. Native Node.js downloadGogV2Depot End-to-End (darwin + win32)
  // =========================================================================
  describe('3. Native Node.js downloadGogV2Depot End-to-End (darwin Bottled + darwin .app + win32 Native)', () => {
    it('interpolates Fastly, Gcore (query-string), and open_link ({path}-less) CDN URL templates accurately', () => {
      const sampleHash = 'abcdef0123456789abcdef0123456789';

      // Fastly {base_url}/token={token}/{path}
      const fastlyUrl = gogDirect.formatGogV2EndpointChunkUrl(
        {
          url_format: '{base_url}/token={token}/{path}',
          parameters: {
            base_url: 'https://gog-cdn-fastly.gog.com',
            token: 'sig_fastly_1',
            path: 'content-system/v2/store',
          },
        },
        sampleHash
      );
      expect(fastlyUrl).toBe(
        `https://gog-cdn-fastly.gog.com/token=sig_fastly_1/content-system/v2/store/ab/cd/${sampleHash}`
      );

      // Gcore {base_url}/{path}?wsSecret={token}&wsTime={time}&prefix={prefix}
      const gcoreUrl = gogDirect.formatGogV2EndpointChunkUrl(
        {
          url_format: '{base_url}/{path}?wsSecret={token}&wsTime={time}&prefix={prefix}',
          parameters: {
            base_url: 'https://gcore.gog.com',
            path: 'store/',
            token: 'sec_99',
            time: 1700000000,
            prefix: 'edge_eu',
          },
        },
        sampleHash
      );
      expect(gcoreUrl).toBe(
        `https://gcore.gog.com/store/ab/cd/${sampleHash}?wsSecret=sec_99&wsTime=1700000000&prefix=edge_eu`
      );

      // open_link without {path} placeholder (url_format, plain string, and { url } object)
      const openPlainUrl = gogDirect.formatGogV2EndpointChunkUrl(
        {
          url_format: 'https://gog-cdn-open.gog.com/open/dependencies/store/',
          parameters: {},
        },
        sampleHash
      );
      expect(openPlainUrl).toBe(
        `https://gog-cdn-open.gog.com/open/dependencies/store/ab/cd/${sampleHash}`
      );

      const openStringUrl = gogDirect.formatGogV2EndpointChunkUrl(
        'https://gog-cdn-open.gog.com/open/dependencies/store',
        sampleHash
      );
      expect(openStringUrl).toBe(
        `https://gog-cdn-open.gog.com/open/dependencies/store/ab/cd/${sampleHash}`
      );
    });

    it('installs Bottled Windows V2 depot on darwin directly into finalInstallPath with DOSBox, sfcRef, uncompressed installSize, heroic_gogdl manifest, and single-batch Wine system.reg sync', async () => {
      const rig = buildSyntheticGogV2CdnRig({ gogOs: 'windows' });
      const finalInstallPath = path.join(tmpRoot, 'Games', 'GOG', SYNTHETIC_TITLE);

      // Provision synthetic CrossOver bottle so syncGogFirstPartyLauncher exercises batched Wine system.reg + live reg.exe import
      const bottlePath = path.join(
        homedir,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'OneLauncher'
      );
      fs.mkdirSync(path.join(bottlePath, 'drive_c', 'ProgramData', 'GOG.com', 'Galaxy'), {
        recursive: true,
      });
      const systemRegPath = path.join(bottlePath, 'system.reg');
      fs.writeFileSync(systemRegPath, 'WINE REGISTRY Version 2\n;; All keys relative to \\\\Machine\n\n', 'utf8');

      const fakeWineBin = path.join(tmpRoot, 'mock-wine64');
      fs.writeFileSync(fakeWineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const liveWineRegImports: Array<{ bin: string; args: string[]; regContent: string }> = [];
      const execFileFn = vi.fn(
        (
          file: string,
          args: string[],
          _opts: unknown,
          cb?: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (Array.isArray(args) && args[0] === 'reg.exe' && args[1] === 'import' && args[2]) {
            const regContent = fs.existsSync(args[2]) ? fs.readFileSync(args[2], 'utf16le') : '';
            liveWineRegImports.push({ bin: file, args: [...args], regContent });
          }
          if (typeof cb === 'function') cb(null, '', '');
        }
      );

      const renameSpy = vi.spyOn(fs, 'renameSync');

      const res = await gogDirect.downloadGogV2Depot(
        {
          taskId: `dl-gog-${SYNTHETIC_GAME_ID}`,
          cleanId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          finalInstallPath,
          gogToken: 'valid_token_123',
          gogPlatformFlag: 'windows',
          includeDlcs: false,
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          fetchImpl: rig.fetchImpl,
          bottlePath,
          wineserverActive: true,
          wineBinaryPath: fakeWineBin,
          execFileFn,
        }
      );

      expect(res.success).toBe(true);
      expect(res.isWindowsBinaryOnMac).toBe(true);
      expect(res.installPath).toBe(finalInstallPath);

      // Zero nested installDirectory subfolder created!
      expect(fs.existsSync(path.join(finalInstallPath, SYNTHETIC_NESTED_FOLDER))).toBe(false);

      // Multi-chunk file, sfcRef small files, primary exe, and DOSBox extracted accurately; __redist skipped
      expect(
        fs.readFileSync(path.join(finalInstallPath, 'base', 'pak0.pak')).equals(rig.expectedPakBuffer)
      ).toBe(true);
      expect(
        fs
          .readFileSync(path.join(finalInstallPath, 'config', 'settings.ini'))
          .equals(rig.expectedIniBuffer)
      ).toBe(true);
      expect(
        fs
          .readFileSync(path.join(finalInstallPath, 'base', 'music', 'track01.ogg'))
          .equals(rig.expectedAudioBuffer)
      ).toBe(true);
      expect(
        fs
          .readFileSync(path.join(finalInstallPath, 'DOSBox', 'DOSBox.exe'))
          .equals(rig.expectedDosboxBuffer)
      ).toBe(true);
      expect(fs.existsSync(path.join(finalInstallPath, '__redist'))).toBe(false);
      expect(fs.existsSync(path.join(finalInstallPath, '.onelauncher-gog-v2-resume.json'))).toBe(
        false
      );

      // Managed install record persists uncompressed disk footprint (> compressed download bytes)
      expect(res.installSize).toBe(rig.expectedUncompressedBasePlusDepBytes);
      expect(res.totalBytes).toBe(rig.expectedCompressedBasePlusDepBytes);
      expect(res.installSize).toBeGreaterThan(res.totalBytes);

      const managedRecords = engineState.loadManagedInstalledGames(userDataDir);
      const gogManaged = managedRecords.find(
        (r: { platformId?: string; platformGameId?: string }) =>
          r.platformId === 'gog' && String(r.platformGameId) === SYNTHETIC_GAME_ID
      );
      expect(gogManaged).toBeDefined();
      expect(gogManaged.installSize).toBe(rig.expectedUncompressedBasePlusDepBytes);

      // heroic_gogdl/manifests/<cleanId> written on darwin
      const macManifestFile = path.join(
        homedir,
        'Library',
        'Application Support',
        'heroic_gogdl',
        'manifests',
        SYNTHETIC_GAME_ID
      );
      expect(fs.existsSync(macManifestFile)).toBe(true);
      const savedManifest = JSON.parse(fs.readFileSync(macManifestFile, 'utf8'));
      expect(savedManifest.version).toBe(2);
      expect(savedManifest.productId).toBe(SYNTHETIC_GAME_ID);
      expect(savedManifest.HGLInstallLanguage).toBeTruthy();
      expect(Array.isArray(savedManifest.HGLdlcs)).toBe(true);

      // Wine system.reg updated with BOTH Wow6432Node and 64-bit GOG keys in ONE atomic rename + ONE reg.exe import
      const systemRegContent = fs.readFileSync(systemRegPath, 'utf8');
      expect(systemRegContent).toContain(
        `[Software\\\\Wow6432Node\\\\GOG.com\\\\Games\\\\${SYNTHETIC_GAME_ID}]`
      );
      expect(systemRegContent).toContain(`[Software\\\\GOG.com\\\\Games\\\\${SYNTHETIC_GAME_ID}]`);
      expect(systemRegContent).toContain(`"gameID"="${SYNTHETIC_GAME_ID}"`);

      const systemRegRenames = renameSpy.mock.calls.filter(
        ([, dest]) => path.resolve(String(dest)) === path.resolve(systemRegPath)
      );
      expect(systemRegRenames).toHaveLength(1);

      expect(liveWineRegImports).toHaveLength(1);
      expect(liveWineRegImports[0].regContent).toContain(
        `[HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\GOG.com\\Games\\${SYNTHETIC_GAME_ID}]`
      );
      expect(liveWineRegImports[0].regContent).toContain(
        `[HKEY_LOCAL_MACHINE\\Software\\GOG.com\\Games\\${SYNTHETIC_GAME_ID}]`
      );
    });

    it('installs native macOS .app bundle on darwin with 0o755 executable permissions and native Windows build on win32', async () => {
      // Case A: darwin native .app bundle
      const macRig = buildSyntheticGogV2CdnRig({ gogOs: 'osx' });
      const macInstallDir = path.join(tmpRoot, 'MacNativeGames', SYNTHETIC_TITLE);

      const macRes = await gogDirect.downloadGogV2Depot(
        {
          cleanId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          finalInstallPath: macInstallDir,
          gogToken: 'valid_token_mac',
          gogPlatformFlag: 'osx',
          platform: 'darwin',
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          fetchImpl: macRig.fetchImpl,
        }
      );

      expect(macRes.success).toBe(true);
      expect(macRes.isWindowsBinaryOnMac).toBe(false);
      const appBundleDir = path.join(macInstallDir, `${SYNTHETIC_NESTED_FOLDER}.app`);
      const macBinPath = path.join(appBundleDir, 'Contents', 'MacOS', 'SyntheticArena');
      expect(fs.existsSync(macBinPath)).toBe(true);
      expect(fs.statSync(macBinPath).mode & 0o111).not.toBe(0);
      expect(
        fs
          .readFileSync(path.join(appBundleDir, 'Contents', 'Resources', 'base', 'pak0.pak'))
          .equals(macRig.expectedPakBuffer)
      ).toBe(true);

      // Case B: win32 native flat extraction + AppData/Roaming/heroic_gogdl/manifests/<id>
      const winRig = buildSyntheticGogV2CdnRig({ gogOs: 'windows' });
      const winHome = path.join(tmpRoot, 'winhome');
      const winUserData = path.join(tmpRoot, 'winuserdata');
      const winInstallDir = path.join(tmpRoot, 'WinGames', 'GOG', SYNTHETIC_TITLE);
      fs.mkdirSync(winHome, { recursive: true });
      fs.mkdirSync(winUserData, { recursive: true });

      const winRes = await gogDirect.downloadGogV2Depot(
        {
          cleanId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          finalInstallPath: winInstallDir,
          gogToken: 'valid_token_win',
          gogPlatformFlag: 'windows',
          platform: 'win32',
        },
        {
          platform: 'win32',
          homedir: winHome,
          userDataDir: winUserData,
          fetchImpl: winRig.fetchImpl,
          skipRegistry: true,
        }
      );

      expect(winRes.success).toBe(true);
      expect(winRes.isWindowsBinaryOnMac).toBe(false);
      expect(fs.existsSync(path.join(winInstallDir, SYNTHETIC_NESTED_FOLDER))).toBe(false);
      expect(fs.existsSync(path.join(winInstallDir, 'game_gog.exe'))).toBe(true);
      expect(fs.existsSync(path.join(winInstallDir, `goggame-${SYNTHETIC_GAME_ID}.info`))).toBe(
        true
      );
      expect(
        fs.existsSync(
          path.join(winHome, 'AppData', 'Roaming', 'heroic_gogdl', 'manifests', SYNTHETIC_GAME_ID)
        )
      ).toBe(true);
    });

    it('rejects tampered chunk MD5s, fails over across CDNs on 503, and recovers automatically from HTTP 401 secure_link / CDN token expiry via refreshGogTokenFn', async () => {
      // 1) Tampered chunk MD5 rejection
      const baseRig = buildSyntheticGogV2CdnRig({ gogOs: 'windows' });
      const firstHash = Array.from(baseRig.chunkMap.keys())[0];
      const tamperedRig = buildSyntheticGogV2CdnRig({
        gogOs: 'windows',
        tamperChunkHash: firstHash,
      });

      await expect(
        gogDirect.downloadGogV2Depot(
          {
            cleanId: SYNTHETIC_GAME_ID,
            title: SYNTHETIC_TITLE,
            finalInstallPath: path.join(tmpRoot, 'TamperedInstall'),
            gogToken: 'valid_token',
            gogPlatformFlag: 'windows',
            platform: 'darwin',
          },
          {
            platform: 'darwin',
            homedir,
            userDataDir,
            fetchImpl: tamperedRig.fetchImpl,
            skipRegistry: true,
          }
        )
      ).rejects.toThrow(/MD5 mismatch/i);

      // 2) Multi-CDN failover (Fastly 503 -> Gcore query-signed URL 200 OK without needing token refresh)
      const failoverRefreshSpy = vi.fn(async () => 'unused_token');
      const failoverRig = buildSyntheticGogV2CdnRig({
        gogOs: 'windows',
        failFastlyEndpointWith503: true,
      });
      const failoverRes = await gogDirect.downloadGogV2Depot(
        {
          cleanId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          finalInstallPath: path.join(tmpRoot, 'FailoverInstall'),
          gogToken: 'valid_token_fo',
          gogPlatformFlag: 'windows',
          platform: 'darwin',
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          fetchImpl: failoverRig.fetchImpl,
          refreshGogTokenFn: failoverRefreshSpy,
          skipRegistry: true,
        }
      );
      expect(failoverRes.success).toBe(true);
      expect(failoverRefreshSpy).not.toHaveBeenCalled();

      // 3) HTTP 401 on initial secure_link AND mid-download chunk expiry triggers refreshGogTokenFn and succeeds
      const refreshGogTokenFn = vi.fn(async () => 'refreshed_token_xyz');
      const authRefreshRig = buildSyntheticGogV2CdnRig({
        gogOs: 'windows',
        requireTokenRefreshOnFirstSecureLink: true,
      });

      const refreshedDir = path.join(tmpRoot, 'RefreshedInstall');
      const okRes = await gogDirect.downloadGogV2Depot(
        {
          cleanId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          finalInstallPath: refreshedDir,
          gogToken: 'expired_token_000',
          gogPlatformFlag: 'windows',
          platform: 'darwin',
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          fetchImpl: authRefreshRig.fetchImpl,
          refreshGogTokenFn,
          skipRegistry: true,
        }
      );
      expect(okRes.success).toBe(true);
      expect(refreshGogTokenFn).toHaveBeenCalledTimes(1);

      // Mid-chunk 401 expiry recovery across all endpoints
      const midChunkRefreshFn = vi.fn(async () => 'refreshed_token_mid');
      const midChunkRig = buildSyntheticGogV2CdnRig({
        gogOs: 'windows',
        requireTokenRefreshOnFirstChunk: true,
      });
      const midChunkDir = path.join(tmpRoot, 'MidChunkRefreshInstall');
      const midOk = await gogDirect.downloadGogV2Depot(
        {
          cleanId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          finalInstallPath: midChunkDir,
          gogToken: 'initial_token_abc',
          gogPlatformFlag: 'windows',
          platform: 'win32',
        },
        {
          platform: 'win32',
          homedir,
          userDataDir,
          fetchImpl: midChunkRig.fetchImpl,
          refreshGogTokenFn: midChunkRefreshFn,
          skipRegistry: true,
        }
      );
      expect(midOk.success).toBe(true);
      expect(midChunkRefreshFn).toHaveBeenCalledTimes(1);
    });

    it('supports pauseDownload -> resumeDownload (skipping completed files) and cancelDownload (.olpart & resume journal cleanup)', async () => {
      const pauseResumeDir = path.join(tmpRoot, 'PauseResumeGame');
      let pausedOnce = false;
      let activeTaskId = '';

      const baseProbeRig = buildSyntheticGogV2CdnRig({ gogOs: 'windows' });
      const exeChunkHash = Array.from(baseProbeRig.chunkMap.keys()).find((h) => {
        const buf = baseProbeRig.chunkMap.get(h);
        return buf && zlib.inflateSync(buf).equals(baseProbeRig.expectedExeBuffer);
      })!;
      const pakLastChunkHash = Array.from(baseProbeRig.chunkMap.keys()).find((h) => {
        const buf = baseProbeRig.chunkMap.get(h);
        return (
          buf &&
          zlib
            .inflateSync(buf)
            .toString('utf8')
            .startsWith('PAK0_SEGMENT_BETA__')
        );
      })!;

      const rig = buildSyntheticGogV2CdnRig({
        gogOs: 'windows',
        onBeforeChunkFetch: async (hash) => {
          // Hold the final pak0.pak chunk until game_gog.exe has atomically committed to disk, then pause!
          if (!pausedOnce && hash === pakLastChunkHash && activeTaskId) {
            for (let i = 0; i < 40; i++) {
              if (fs.existsSync(path.join(pauseResumeDir, 'game_gog.exe'))) break;
              await new Promise((r) => setTimeout(r, 5));
            }
            pausedOnce = true;
            launcherEngine.pauseDownload(activeTaskId, { platform: 'darwin', userDataDir });
          }
        },
      });

      const installOpts = {
        platform: 'darwin',
        homedir,
        userDataDir,
        gogAccessToken: 'valid_token_pr',
        useNativeGogDepotDownloader: true,
        fetchImpl: rig.fetchImpl,
        skipRegistry: true,
      };

      const startRes = await launcherEngine.installGame(
        {
          gameId: `gog-${SYNTHETIC_GAME_ID}`,
          platformId: 'gog',
          platformGameId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          installPath: pauseResumeDir,
          os: 'windows',
        },
        installOpts
      );
      expect(startRes.success).toBe(true);
      activeTaskId = startRes.task.taskId;

      // Wait for async depot worker to hit pause checkpoint and flush resume journal
      const resumeJournalPath = path.join(pauseResumeDir, '.onelauncher-gog-v2-resume.json');
      await vi.waitFor(
        () => {
          const t = engineState.downloadQueueMap.get(activeTaskId);
          expect(t?.status).toBe('paused');
          expect(fs.existsSync(resumeJournalPath)).toBe(true);
        },
        { timeout: 3000, interval: 15 }
      );

      const savedJournal = JSON.parse(fs.readFileSync(resumeJournalPath, 'utf8'));
      expect(savedJournal.completedFiles['game_gog.exe']).toBeDefined();

      // game_gog.exe's chunk was fetched once before pause; it MUST NOT be re-downloaded on resume!
      expect(rig.chunkFetchCounts.get(exeChunkHash)).toBe(1);

      const resumeRes = launcherEngine.resumeDownload(activeTaskId, installOpts);
      expect(resumeRes.success).toBe(true);

      await vi.waitFor(
        () => {
          const t = engineState.downloadQueueMap.get(activeTaskId);
          expect(t?.status).toBe('completed');
        },
        { timeout: 3000, interval: 15 }
      );

      // Already-completed game_gog.exe chunk was never fetched a second time!
      expect(rig.chunkFetchCounts.get(exeChunkHash)).toBe(1);
      expect(fs.existsSync(resumeJournalPath)).toBe(false);
      expect(
        fs.readFileSync(path.join(pauseResumeDir, 'base', 'pak0.pak')).equals(rig.expectedPakBuffer)
      ).toBe(true);

      // Now verify cancelDownload purges .olpart staging files and .onelauncher-gog-v2-resume.json
      const cancelDir = path.join(tmpRoot, 'CancelCleanupGame');
      let cancelTaskId = '';
      let resolveCancelGate: (() => void) | null = null;
      const cancelRig = buildSyntheticGogV2CdnRig({
        gogOs: 'windows',
        onBeforeChunkFetch: async (hash) => {
          if (hash === pakLastChunkHash) {
            // Wait until pakChunk0 has created the real base/pak0.pak.olpart file on disk, then hold pakLastChunkHash
            for (let i = 0; i < 40; i++) {
              if (fs.existsSync(path.join(cancelDir, 'base', 'pak0.pak.olpart'))) break;
              await new Promise((r) => setTimeout(r, 5));
            }
            fs.writeFileSync(
              path.join(cancelDir, '.onelauncher-gog-v2-resume.json'),
              JSON.stringify({ schemaVersion: 1 }),
              'utf8'
            );
            await new Promise<void>((resolve) => {
              resolveCancelGate = resolve;
            });
          }
        },
      });

      const cancelStart = await launcherEngine.installGame(
        {
          gameId: 'gog-9900112244',
          platformId: 'gog',
          platformGameId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          installPath: cancelDir,
          os: 'windows',
        },
        {
          ...installOpts,
          fetchImpl: cancelRig.fetchImpl,
        }
      );
      cancelTaskId = cancelStart.task.taskId;

      await vi.waitFor(
        () => {
          expect(fs.existsSync(path.join(cancelDir, 'base', 'pak0.pak.olpart'))).toBe(true);
        },
        { timeout: 3000, interval: 15 }
      );

      const cancelRes = launcherEngine.cancelDownload(cancelTaskId, {
        platform: 'darwin',
        userDataDir,
      });
      if (resolveCancelGate) (resolveCancelGate as () => void)();

      expect(cancelRes.success).toBe(true);
      expect(cancelRes.task.status).toBe('cancelled');
      expect(fs.existsSync(path.join(cancelDir, 'base', 'pak0.pak.olpart'))).toBe(false);
      expect(fs.existsSync(path.join(cancelDir, '.onelauncher-gog-v2-resume.json'))).toBe(false);
    });
  });

  // =========================================================================
  // 4. Fast Direct HTTP resolveGogDepotSizesDirectHttp & getGameInstallInfo
  // =========================================================================
  describe('4. Fast Direct HTTP resolveGogDepotSizesDirectHttp & getGameInstallInfo Zero-Spawn Path', () => {
    it('resolves exact V2 compressed downloadSizeBytes, uncompressed estimatedSizeBytes, and dlcSizeBytes with 0 gogdl subprocess spawns', async () => {
      const rig = buildSyntheticGogV2CdnRig({ gogOs: 'windows' });
      const spawnSpy = vi.spyOn(childProcess, 'spawn');
      const execFileSpy = vi.spyOn(childProcess, 'execFile');

      const directSizes = await gogDirect.resolveGogDepotSizesDirectHttp(
        SYNTHETIC_GAME_ID,
        'windows',
        { fetchImpl: rig.fetchImpl }
      );
      expect(directSizes).not.toBeNull();
      expect(directSizes.downloadSize).toBe(rig.expectedBaseCompressedBytes);
      expect(directSizes.diskSize).toBe(rig.expectedBaseUncompressedBytes);
      expect(directSizes.dlcDownloadSize).toBe(rig.expectedDlcCompressedBytes);
      expect(directSizes.dlcSize).toBe(rig.expectedDlcUncompressedBytes);

      for (const targetPlatform of ['darwin', 'win32'] as const) {
        const info = await launcherEngine.getGameInstallInfo(
          {
            gameId: `gog-${SYNTHETIC_GAME_ID}`,
            platformId: 'gog',
            platformGameId: SYNTHETIC_GAME_ID,
            title: SYNTHETIC_TITLE,
          },
          {
            platform: targetPlatform,
            homedir,
            userDataDir,
            fetchImpl: rig.fetchImpl,
            savedTokens: {},
          }
        );

        expect(info.downloadSizeBytes).toBe(rig.expectedBaseCompressedBytes);
        expect(info.estimatedSizeBytes).toBe(rig.expectedBaseUncompressedBytes);
        expect(info.dlcSizeBytes).toBe(rig.expectedDlcUncompressedBytes);
      }

      // Zero gogdl subprocess spawns!
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(execFileSpy).not.toHaveBeenCalled();
    });

    it('preserves DI options.execFileFn fallback compatibility in getGameInstallInfo when explicitly supplied', async () => {
      const fakeGogdl = path.join(tmpRoot, 'mock-gogdl');
      fs.writeFileSync(fakeGogdl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const execFileFn = vi.fn(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(
            null,
            JSON.stringify({
              disk_size: 4837509036,
              download_size: 3729750320,
              dlcs: [
                {
                  title: 'Expansion Pack',
                  download_size: 256000000,
                  disk_size: 512000000,
                },
              ],
            }),
            ''
          );
        }
      );

      const info = await launcherEngine.getGameInstallInfo(
        {
          gameId: `gog-${SYNTHETIC_GAME_ID}`,
          platformId: 'gog',
          platformGameId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          gogdlBinaryPath: fakeGogdl,
          gogAccessToken: '',
          savedTokens: { gog: { access_token: '' } },
          // Write a synthetic auth config file so gogAuthExists is true without triggering online api.gog.com fetch
          gogAuthConfigPath: (() => {
            const p = path.join(userDataDir, 'gog_store', 'auth.json');
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, '{}', 'utf8');
            return p;
          })(),
          execFileFn,
        }
      );

      // Probes osx + windows on darwin via DI execFileFn
      expect(execFileFn).toHaveBeenCalledTimes(2);
      expect(info.downloadSizeBytes).toBe(3729750320);
      expect(info.estimatedSizeBytes).toBe(4837509036);
      expect(info.dlcSizeBytes).toBe(512000000);
    });
  });

  // =========================================================================
  // 5. Hardened gogdl CLI Output Telemetry + DownloadManagerDrawer Disk UX
  // =========================================================================
  describe('5. Hardened gogdl CLI Output Telemetry + DownloadManagerDrawer Live Disk Speed UX', () => {
    it('preserves compressed totalBytes across bare tuples & Progress lines, transitions to extracting with live Disk speed/ETA, and renders accurately in DownloadManagerDrawer', async () => {
      const fakeGogdl = path.join(tmpRoot, 'gogdl-cli');
      fs.writeFileSync(fakeGogdl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const cliInstallDir = path.join(tmpRoot, 'CliTelemetryGame', SYNTHETIC_TITLE);

      class MockChildProcess extends EventEmitter {
        stdout = new EventEmitter();
        stderr = new EventEmitter();
        pid = 42424;
        kill = vi.fn();
      }

      let spawnedChild: MockChildProcess | null = null;
      const spawnFn = vi.fn(() => {
        spawnedChild = new MockChildProcess();
        return spawnedChild;
      });

      const startRes = await launcherEngine.installGame(
        {
          gameId: `gog-${SYNTHETIC_GAME_ID}`,
          platformId: 'gog',
          platformGameId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          installPath: cliInstallDir,
          os: 'windows',
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          gogdlBinaryPath: fakeGogdl,
          gogAccessToken: 'cli_token_synthetic',
          spawnFn,
        }
      );

      expect(startRes.success).toBe(true);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(spawnedChild).not.toBeNull();
      const taskId = startRes.task.taskId;

      // 1) Emit gogdl 1.3.0 bare size tuples: Download size first, Disk size second
      spawnedChild!.stderr.emit(
        'data',
        Buffer.from(
          `INFO:root:Download size: (3.47, 'GB') 3729750320\nINFO:root:Disk size: (4.51, 'GB') 4837509036\n`,
          'utf8'
        )
      );

      let liveTask = engineState.downloadQueueMap.get(taskId);
      expect(liveTask.totalBytes).toBe(3729750320);
      expect(liveTask.diskSizeBytes).toBe(4837509036);

      // 2) Emit mid-download Progress line whose denominator is uncompressed disk size (4837509036)
      spawnedChild!.stderr.emit(
        'data',
        Buffer.from(
          [
            `Progress: 50.00 2418754518/4837509036`,
            `Downloaded: 1778.48 MiB`,
            `Written: 2200.00 MiB`,
            `+ Download - 48.00 MiB/s (raw) / 62.00 MiB/s (decompressed)`,
            `+ Disk - 60.00 MiB/s (write)`,
            '',
          ].join('\n'),
          'utf8'
        )
      );

      liveTask = engineState.downloadQueueMap.get(taskId);
      // Compressed totalBytes (3729750320) must NEVER be clobbered by uncompressed 4837509036!
      expect(liveTask.totalBytes).toBe(3729750320);
      expect(liveTask.bytesDownloaded).toBeLessThanOrEqual(liveTask.totalBytes);
      expect(liveTask.status).toBe('downloading');

      // 3) Emit tail disk-assembly telemetry: Download 0.00 MiB/s, Disk 180.00 MiB/s, Downloaded >= 99%
      spawnedChild!.stderr.emit(
        'data',
        Buffer.from(
          [
            `Progress: 99.80 4827834018/4837509036`,
            `Downloaded: 3556.97 MiB`,
            `Written: 3900.00 MiB`,
            `+ Download - 0.00 MiB/s (raw) / 0.00 MiB/s (decompressed)`,
            `+ Disk - 180.00 MiB/s (write)`,
            '',
          ].join('\n'),
          'utf8'
        )
      );

      liveTask = engineState.downloadQueueMap.get(taskId);
      expect(liveTask.totalBytes).toBe(3729750320);
      expect(liveTask.bytesDownloaded).toBe(3729750320);
      expect(liveTask.bytesDownloaded).toBeLessThanOrEqual(liveTask.totalBytes);
      expect(liveTask.status).toBe('extracting');
      expect(liveTask.speedBytesPerSec).toBe(180 * 1024 * 1024);
      expect(liveTask.etaSeconds).toBeGreaterThan(0);

      // 4) Render DownloadManagerDrawer directly with this live extracting task state
      const drawerTask: DownloadTaskState = {
        taskId: liveTask.taskId,
        gameId: liveTask.gameId,
        platformId: 'gog',
        platformGameId: SYNTHETIC_GAME_ID,
        title: SYNTHETIC_TITLE,
        installDir: path.dirname(cliInstallDir),
        finalInstallPath: cliInstallDir,
        status: liveTask.status,
        progressPercent: liveTask.progressPercent,
        bytesDownloaded: liveTask.bytesDownloaded,
        totalBytes: liveTask.totalBytes,
        speedBytesPerSec: liveTask.speedBytesPerSec,
        etaSeconds: liveTask.etaSeconds,
        statusMessage: liveTask.statusMessage,
        startedAt: new Date(Date.now() - 5000).toISOString(),
      };

      vi.spyOn(launcherService, 'getDownloadQueue').mockReturnValue([drawerTask]);
      vi.spyOn(launcherService, 'subscribe').mockImplementation(() => () => {});

      const harness = createComponentHarness(DownloadManagerDrawer, {
        isOpen: true,
        onClose: () => {},
      });
      const tree = harness.render();
      const text = getTextContent(tree);

      expect(text).toContain(SYNTHETIC_TITLE);
      expect(text).toContain('Extracting');
      expect(text).toContain('Disk 180.0 MB/s');
      expect(text).toContain('ETA 00:04');
      expect(text).toContain('3.47 GB / 3.47 GB');

      harness.unmount();
    });
  });

  // =========================================================================
  // 6. Split/Nested GOG Parent Directory Cleanup in uninstallGame
  // =========================================================================
  describe('6. Split/Nested GOG Parent Directory Cleanup in uninstallGame (darwin & win32)', () => {
    it.each(['darwin', 'win32'] as const)(
      'deletes both nested subfolder and orphaned managed GOG parent folder on %s while preserving sibling games',
      async (targetPlatform) => {
        const gogLibraryRoot = path.join(tmpRoot, `UninstallLib_${targetPlatform}`, 'GOG');
        const splitParentDir = path.join(gogLibraryRoot, SYNTHETIC_TITLE);
        const nestedInstallDir = path.join(splitParentDir, SYNTHETIC_NESTED_FOLDER);
        const siblingGameDir = path.join(gogLibraryRoot, 'Other Synthetic Game');

        fs.mkdirSync(nestedInstallDir, { recursive: true });
        fs.mkdirSync(siblingGameDir, { recursive: true });

        // Sibling game must remain completely untouched
        const siblingExePath = path.join(siblingGameDir, 'other_arena.exe');
        fs.writeFileSync(siblingExePath, makePeBinaryBuffer('SIBLING_SAFE', 8));

        // Managed split parent + nested install
        engineState.writeManagedInstallSentinel(splitParentDir, {
          store: 'gog',
          gameId: SYNTHETIC_GAME_ID,
          installKind: 'gog-direct',
        });
        fs.writeFileSync(
          path.join(splitParentDir, `goggame-${SYNTHETIC_GAME_ID}.info`),
          JSON.stringify({ gameId: SYNTHETIC_GAME_ID, name: SYNTHETIC_TITLE }),
          'utf8'
        );
        fs.writeFileSync(
          path.join(nestedInstallDir, `goggame-${SYNTHETIC_GAME_ID}.info`),
          JSON.stringify({ gameId: SYNTHETIC_GAME_ID, name: SYNTHETIC_TITLE }),
          'utf8'
        );
        fs.writeFileSync(
          path.join(nestedInstallDir, 'game_gog.exe'),
          makePeBinaryBuffer('NESTED_UNINSTALL', 12)
        );

        const res = await launcherEngine.uninstallGame(
          {
            gameId: `gog-${SYNTHETIC_GAME_ID}`,
            platformId: 'gog',
            platformGameId: SYNTHETIC_GAME_ID,
            title: SYNTHETIC_TITLE,
            installPath: nestedInstallDir,
          },
          {
            platform: targetPlatform,
            homedir,
            userDataDir,
            skipRegistry: true,
          }
        );

        expect(res.success).toBe(true);
        expect(fs.existsSync(nestedInstallDir)).toBe(false);
        expect(fs.existsSync(splitParentDir)).toBe(false);
        // Library root and sibling game directory must remain completely intact!
        expect(fs.existsSync(gogLibraryRoot)).toBe(true);
        expect(fs.existsSync(siblingExePath)).toBe(true);
      }
    );

    it('deletes split parent identified by goggame-<id>.info with allowDeleteFiles, while preserving non-matching shared parent containers', async () => {
      // Subcase A: Split parent identified via goggame-<id>.info (no sentinel) + allowDeleteFiles: true
      const infoOnlyLib = path.join(tmpRoot, 'InfoOnlySplitLib', 'GOG');
      const infoSplitParent = path.join(infoOnlyLib, SYNTHETIC_TITLE);
      const infoNestedDir = path.join(infoSplitParent, SYNTHETIC_NESTED_FOLDER);
      fs.mkdirSync(infoNestedDir, { recursive: true });
      fs.writeFileSync(
        path.join(infoSplitParent, `goggame-${SYNTHETIC_GAME_ID}.info`),
        JSON.stringify({ gameId: SYNTHETIC_GAME_ID, name: SYNTHETIC_TITLE }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(infoNestedDir, 'game_gog.exe'),
        makePeBinaryBuffer('INFO_SPLIT', 8)
      );

      const infoRes = await launcherEngine.uninstallGame(
        {
          gameId: `gog-${SYNTHETIC_GAME_ID}`,
          platformId: 'gog',
          platformGameId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          installPath: infoNestedDir,
          allowDeleteFiles: true,
        },
        {
          platform: 'win32',
          homedir,
          userDataDir,
          skipRegistry: true,
        }
      );
      expect(infoRes.success).toBe(true);
      expect(fs.existsSync(infoNestedDir)).toBe(false);
      expect(fs.existsSync(infoSplitParent)).toBe(false);
      expect(fs.existsSync(infoOnlyLib)).toBe(true);

      // Subcase B: Shared custom parent container (no matching gameId sentinel or goggame-<id>.info on parent)
      const sharedParentDir = path.join(tmpRoot, 'SharedParentLib', 'CustomCollection');
      const nestedInstallDir = path.join(sharedParentDir, SYNTHETIC_NESTED_FOLDER);
      const unrelatedSubDir = path.join(sharedParentDir, 'Custom Mod Pack');

      fs.mkdirSync(nestedInstallDir, { recursive: true });
      fs.mkdirSync(unrelatedSubDir, { recursive: true });

      engineState.writeManagedInstallSentinel(nestedInstallDir, {
        store: 'gog',
        gameId: SYNTHETIC_GAME_ID,
        installKind: 'gog-direct',
      });
      fs.writeFileSync(path.join(unrelatedSubDir, 'mod_readme.txt'), 'KEEP_ME', 'utf8');
      fs.writeFileSync(
        path.join(nestedInstallDir, 'game_gog.exe'),
        makePeBinaryBuffer('SHARED_NESTED', 8)
      );

      const res = await launcherEngine.uninstallGame(
        {
          gameId: `gog-${SYNTHETIC_GAME_ID}`,
          platformId: 'gog',
          platformGameId: SYNTHETIC_GAME_ID,
          title: SYNTHETIC_TITLE,
          installPath: nestedInstallDir,
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          skipRegistry: true,
        }
      );

      expect(res.success).toBe(true);
      expect(fs.existsSync(nestedInstallDir)).toBe(false);
      // Shared parent and unrelated sibling directory must never be wiped!
      expect(fs.existsSync(sharedParentDir)).toBe(true);
      expect(fs.existsSync(path.join(unrelatedSubDir, 'mod_readme.txt'))).toBe(true);
    });
  });
});
