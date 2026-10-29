import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

import type { CanonicalGame } from '../src/contracts/game';
import type { GameInstallInfo } from '../src/contracts/launcher';
import {
  MAX_PLAUSIBLE_GAME_INSTALL_BYTES,
  formatBytes,
  formatByteSize,
  sanitizeGameInstallSizeBytes as sanitizeClientBytes,
  parseStorageRequirementBytesClient,
  parseStorageRequirementTextClient,
} from '../src/utils/formatBytes';
import {
  preserveLocalInstallFieldsAcrossSanitize,
  reconcileCatalogGamesWithInstalledRecords,
  loadCurrentCatalog,
} from '../src/services/integrations/integrationStorage';
import { launcherService } from '../src/services/launcher/launcherService';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';

vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

const requireCjs = createRequire(import.meta.url);
const inspectors = requireCjs('../electron/launcher/binaryAndManifestInspectors.cjs');
const launcherEngine = requireCjs('../electron/launcherEngine.cjs');

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

if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = mockStorage;
}
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
}

const eventTarget = new EventTarget();

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    addEventListener: (type: string, listener: any) => eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: any) => eventTarget.dispatchEvent(event),
    localStorage: mockStorage,
    location: { hostname: 'example.com' },
    innerWidth: 1440,
    innerHeight: 900,
    electronAPI: { platform: 'darwin' },
  };
}

if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = {
    addEventListener: (type: string, listener: any) => eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener),
    body: {},
  };
}

// ---------------------------------------------------------------------------
// Stateful React 19 Component Test Harness
// ---------------------------------------------------------------------------
function findElements(node: any, predicate: (el: any) => boolean, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props && node.props.children) {
    findElements(node.props.children, predicate, acc);
  }
  return acc;
}

function getTextContent(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (node && typeof node === 'object' && node.props) {
    return getTextContent(node.props.children);
  }
  return '';
}

function createComponentHarness<P extends object>(Component: React.FC<P>, initialProps: P) {
  const states: any[] = [];
  const refs: Array<{ current: any }> = [];
  const prevDeps: Array<any[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  let currentProps = initialProps;

  const render = (nextProps?: Partial<P>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    const pendingEffects: Array<{ idx: number; fn: () => any }> = [];

    const internals = (React as any)
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    const runEffectHook = (fn: () => any, deps?: any[]) => {
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
      useState(initial: any) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? initial() : initial);
        }
        const setState = (updater: any) => {
          states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
        };
        return [states[idx], setState];
      },
      useRef(initial: any) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useEffect: runEffectHook,
      useLayoutEffect: runEffectHook,
      useMemo(fn: () => any) {
        return fn();
      },
      useCallback(fn: any) {
        return fn;
      },
      useDeferredValue(val: any) {
        return val;
      },
      useTransition() {
        return [false, (fn: () => void) => fn()];
      },
      useContext(ctx: any) {
        return ctx._currentValue;
      },
      useId() {
        return 'mock-id';
      },
    };

    let tree: any;
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
      cleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
    }

    return tree;
  };

  const unmount = () => {
    for (const c of cleanups) {
      if (typeof c === 'function') c();
    }
  };

  return { render, unmount, states, refs };
}

async function flushMicrotasks(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Synthetic Epic Manifest Builders (JSON %03d Blob & Binary 0x44BEC00C)
// ---------------------------------------------------------------------------
function encodeEpicJsonBlobInt(value: number | bigint, byteCount: 4 | 8 = 4): string {
  let rem = BigInt(value);
  let out = '';
  for (let i = 0; i < byteCount; i++) {
    const byteVal = Number(rem & 0xffn);
    out += String(byteVal).padStart(3, '0');
    rem >>= 8n;
  }
  return out;
}

function encodeFStringAscii(str: string): Buffer {
  if (!str) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(0, 0);
    return b;
  }
  const strBuf = Buffer.from(`${str}\0`, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeInt32LE(strBuf.length, 0);
  return Buffer.concat([lenBuf, strBuf]);
}

function encodeFStringUtf16LE(str: string): Buffer {
  const charCountWithNull = str.length + 1;
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeInt32LE(-charCountWithNull, 0);
  const strBuf = Buffer.from(`${str}\0`, 'utf16le');
  return Buffer.concat([lenBuf, strBuf]);
}

interface SyntheticChunkSpec {
  windowSize: number;
  fileSize: bigint;
}

interface SyntheticFileSpec {
  filename: string;
  utf16Filename?: boolean;
  symlinkTarget?: string;
  installTags?: string[];
  partSizes: number[];
  mimeType?: string;
  uncompressedSize?: bigint;
}

interface SyntheticBinaryManifestOptions {
  headerSize?: number;
  manifestVersion?: number;
  storedAs?: number;
  cdlVersion?: 0 | 1;
  fmlVersion?: 0 | 1 | 2;
  chunks: SyntheticChunkSpec[];
  files: SyntheticFileSpec[];
  overridePartStructSize?: number;
  truncateFmlByBytes?: number;
}

function buildSyntheticEpicBinaryManifest(opts: SyntheticBinaryManifestOptions): Buffer {
  const headerSize = opts.headerSize ?? 41;
  const manifestVersion = opts.manifestVersion ?? 21;
  const storedAs = opts.storedAs ?? 0x01;
  const cdlVersion = opts.cdlVersion ?? 0;
  const fmlVersion = opts.fmlVersion ?? 0;

  // 1. Minimal FManifestMeta section (data_size = 16)
  const metaBuf = Buffer.alloc(16);
  metaBuf.writeUInt32LE(16, 0);
  metaBuf.writeUInt8(0, 4);

  // 2. ChunkDataList (CDL)
  const cdlCount = opts.chunks.length;
  const perChunkFixed = 16 + 8 + 20 + 1; // guid(16) + hash(8) + sha1(20) + group(1)
  const cdlV1Extra = cdlVersion >= 1 ? cdlCount * 32 : 0; // FL >= 22 trailing SHA-256 per chunk
  const cdlSize = 9 + cdlCount * perChunkFixed + cdlCount * 4 + cdlCount * 8 + cdlV1Extra;
  const cdlBuf = Buffer.alloc(cdlSize);
  cdlBuf.writeUInt32LE(cdlSize, 0);
  cdlBuf.writeUInt8(cdlVersion, 4);
  cdlBuf.writeUInt32LE(cdlCount, 5);

  const windowStart = 9 + cdlCount * perChunkFixed;
  const fileSizeStart = windowStart + cdlCount * 4;
  for (let i = 0; i < cdlCount; i++) {
    cdlBuf.writeUInt32LE(opts.chunks[i].windowSize >>> 0, windowStart + i * 4);
    cdlBuf.writeBigInt64LE(opts.chunks[i].fileSize, fileSizeStart + i * 8);
  }
  if (cdlV1Extra > 0) {
    cdlBuf.fill(0xab, fileSizeStart + cdlCount * 8);
  }

  // 3. FileManifestList (FML)
  const fmlCount = opts.files.length;
  const fmlChunks: Buffer[] = [];

  // Filenames
  for (const f of opts.files) {
    fmlChunks.push(
      f.utf16Filename ? encodeFStringUtf16LE(f.filename) : encodeFStringAscii(f.filename)
    );
  }
  // Symlink targets
  for (const f of opts.files) {
    fmlChunks.push(encodeFStringAscii(f.symlinkTarget || ''));
  }
  // Hash (20B) + Flags (1B) = 21B * count
  fmlChunks.push(Buffer.alloc(fmlCount * 21, 0x11));

  // InstallTags
  for (const f of opts.files) {
    const tags = f.installTags || [];
    const cntBuf = Buffer.alloc(4);
    cntBuf.writeUInt32LE(tags.length, 0);
    fmlChunks.push(cntBuf);
    for (const tag of tags) {
      fmlChunks.push(encodeFStringAscii(tag));
    }
  }

  // FileChunkParts
  for (const f of opts.files) {
    const pCntBuf = Buffer.alloc(4);
    pCntBuf.writeUInt32LE(f.partSizes.length, 0);
    fmlChunks.push(pCntBuf);
    for (const partSize of f.partSizes) {
      const actualBufLen = 28;
      const declaredStructSize = opts.overridePartStructSize ?? actualBufLen;
      const partBuf = Buffer.alloc(actualBufLen);
      partBuf.writeUInt32LE(declaredStructSize >>> 0, 0);
      // 16B guid at 4..19, 4B offset at 20..23, 4B size at 24..27
      partBuf.writeUInt32LE(0, 20);
      partBuf.writeUInt32LE(partSize >>> 0, 24);
      fmlChunks.push(partBuf);
    }
  }

  // FML v1 trailing fields: mime_type FString[] + md5 (16B * count) + sha256 (32B * count)
  if (fmlVersion >= 1) {
    for (const f of opts.files) {
      fmlChunks.push(encodeFStringAscii(f.mimeType || 'application/octet-stream'));
    }
    fmlChunks.push(Buffer.alloc(fmlCount * (16 + 32), 0x22));
  }

  // FML v2 trailing field: uncompressed_size uint64[]
  if (fmlVersion >= 2) {
    const uncompBuf = Buffer.alloc(fmlCount * 8);
    for (let i = 0; i < fmlCount; i++) {
      const sumParts = opts.files[i].partSizes.reduce((acc, s) => acc + BigInt(s), 0n);
      uncompBuf.writeBigUInt64LE(opts.files[i].uncompressedSize ?? sumParts, i * 8);
    }
    fmlChunks.push(uncompBuf);
  }

  let fmlPayload = Buffer.concat(fmlChunks);
  const declaredFmlSize = 9 + fmlPayload.length;
  if (opts.truncateFmlByBytes && opts.truncateFmlByBytes > 0) {
    fmlPayload = fmlPayload.subarray(0, Math.max(0, fmlPayload.length - opts.truncateFmlByBytes));
  }
  const fmlHeader = Buffer.alloc(9);
  fmlHeader.writeUInt32LE(declaredFmlSize, 0);
  fmlHeader.writeUInt8(fmlVersion, 4);
  fmlHeader.writeUInt32LE(fmlCount, 5);
  const fmlBuf = Buffer.concat([fmlHeader, fmlPayload]);

  // CustomFields stub (minimal 9 bytes)
  const customFields = Buffer.alloc(9);
  customFields.writeUInt32LE(9, 0);

  const uncompressedBody = Buffer.concat([metaBuf, cdlBuf, fmlBuf, customFields]);
  const wireBody =
    (storedAs & 0x2) !== 0
      ? Buffer.from(uncompressedBody.map((b) => b ^ 0xa5))
      : (storedAs & 0x1) !== 0
        ? zlib.deflateSync(uncompressedBody)
        : uncompressedBody;

  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(0x44bec00c, 0);
  header.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(uncompressedBody.length, 8);
  header.writeUInt32LE(wireBody.length, 12);
  header.writeUInt8(storedAs, 36);
  header.writeUInt32LE(manifestVersion, 37);

  return Buffer.concat([header, wireBody]);
}

function makeSyntheticGame(overrides: Partial<CanonicalGame> = {}): CanonicalGame {
  return {
    id: 'epic-synth-builder-sim',
    title: 'Synthetic PC Builder Sim',
    sortTitle: 'Synthetic PC Builder Sim',
    headerImage: 'https://example.com/header.jpg',
    shortDescription: 'Build and diagnose custom PCs.',
    developers: ['Synth Studio'],
    publishers: ['Synth Publisher'],
    genres: ['Simulation'],
    tags: ['Simulation', 'Building'],
    releaseDate: '2021-01-15',
    platforms: [
      {
        platformId: 'epic',
        platformGameId: 'synth_builder_app_01',
        installed: false,
        playtimeMinutes: 0,
      },
    ],
    ...overrides,
  };
}

describe('Cross-Storefront Install Size, Epic Manifest Parsers, Dual-OS Separation & Disk-Space Guard Suite', () => {
  const tempDirs: string[] = [];
  let savedGlobalFetch: typeof globalThis.fetch;

  function createSandboxDir(label: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `ol-size-qa-${label}-`));
    tempDirs.push(d);
    return d;
  }

  beforeEach(() => {
    savedGlobalFetch = globalThis.fetch;
    mockStorage.clear();
    launcherEngine.setUserDataDir(null);
    if ((globalThis as any).window?.electronAPI) {
      (globalThis as any).window.electronAPI.platform = 'darwin';
    }
  });

  afterEach(() => {
    globalThis.fetch = savedGlobalFetch;
    vi.restoreAllMocks();
    launcherEngine.setUserDataDir(null);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir && fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  // =========================================================================
  // 1. Epic JSON Manifest %03d Byte-Triplet Decoding
  // =========================================================================
  describe('1. Epic JSON Manifest %03d Byte-Triplet Decoding (decodeEpicJsonBlobInt & parseEpicManifestBuffer)', () => {
    it('decodes Unreal Engine %03d little-endian byte-triplet strings accurately instead of decimal numbers', () => {
      // Root cause of PC Building Simulator 253,114.6 GB bug:
      // "121001000000" = bytes [121, 1, 0, 0] LE = 121 + 256 = 377 bytes (NOT 121,001,000,000 bytes!)
      expect(inspectors.decodeEpicJsonBlobInt('121001000000')).toBe(377);
      // FeatureLevel 13 -> "013000000000"
      expect(inspectors.decodeEpicJsonBlobInt('013000000000')).toBe(13);
      // 1 MiB chunk -> 1048576 = [0, 0, 16, 0] -> "000000016000"
      expect(inspectors.decodeEpicJsonBlobInt('000000016000')).toBe(1048576);
      // 24-char uint64 string in ChunkFilesizeList (e.g. 5 GiB = 5,368,709,120)
      const fiveGiBEncoded = encodeEpicJsonBlobInt(5_368_709_120n, 8);
      expect(fiveGiBEncoded).toHaveLength(24);
      expect(inspectors.decodeEpicJsonBlobInt(fiveGiBEncoded)).toBe(5_368_709_120);
    });

    it('rejects invalid or corrupt %03d byte triplets (> 255, malformed length, non-digits, unsafe integers)', () => {
      expect(inspectors.decodeEpicJsonBlobInt('299000000000')).toBeNull();
      expect(inspectors.decodeEpicJsonBlobInt('256000000000')).toBeNull();
      expect(inspectors.decodeEpicJsonBlobInt('000999000000')).toBeNull();
      expect(inspectors.decodeEpicJsonBlobInt('12100100000')).toBeNull(); // length 11
      expect(inspectors.decodeEpicJsonBlobInt('12a001000000')).toBeNull();
      expect(inspectors.decodeEpicJsonBlobInt('')).toBeNull();
      // Max uint64 exceeds Number.MAX_SAFE_INTEGER
      expect(inspectors.decodeEpicJsonBlobInt('255255255255255255255255')).toBeNull();
    });

    it('parses uncompressed, UTF-8 BOM + whitespace prefixed, and zlib-compressed Epic %03d JSON manifests with 0-byte delta', () => {
      const partA = 377; // "121001000000"
      const partB = 1_048_576; // 1 MiB
      const partC = 52_428_800; // 50 MiB
      const expectedDiskSize = partA + partB + partC;

      const chunkDlA = 412_345n;
      const chunkDlB = 28_901_234n;
      const expectedDownloadSize = Number(chunkDlA + chunkDlB);

      const epicJsonObj = {
        ManifestFileVersion: '013000000000',
        bIsFileData: false,
        AppID: '000000000000',
        AppNameString: 'SynthBuilderApp',
        BuildVersionString: '1.15.4',
        FileManifestList: [
          {
            Filename: 'PCBS_Data/boot.config',
            FileChunkParts: [
              {
                Guid: 'AAAABBBBCCCCDDDDEEEEFFFF00001111',
                Offset: '000000000000',
                Size: '121001000000', // 377 bytes
              },
            ],
          },
          {
            Filename: 'PCBS_Data/sharedassets0.assets',
            FileChunkParts: [
              {
                Guid: 'AAAABBBBCCCCDDDDEEEEFFFF00001111',
                Offset: encodeEpicJsonBlobInt(377, 4),
                Size: encodeEpicJsonBlobInt(partB, 4),
              },
              {
                Guid: '22223333444455556666777788889999',
                Offset: '000000000000',
                Size: encodeEpicJsonBlobInt(partC, 4),
              },
            ],
          },
        ],
        ChunkFilesizeList: {
          AAAABBBBCCCCDDDDEEEEFFFF00001111: encodeEpicJsonBlobInt(chunkDlA, 8),
          '22223333444455556666777788889999': encodeEpicJsonBlobInt(chunkDlB, 8),
        },
      };

      const rawJsonStr = JSON.stringify(epicJsonObj);

      // (a) Uncompressed JSON buffer
      const parsedUncompressed = inspectors.parseEpicManifestBuffer(Buffer.from(rawJsonStr, 'utf8'));
      expect(parsedUncompressed).toEqual({
        diskSize: expectedDiskSize,
        downloadSize: expectedDownloadSize,
      });

      // (b) UTF-8 BOM + leading whitespace prefixed JSON buffer
      const bomPrefixedBuf = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('\r\n  \t ', 'utf8'),
        Buffer.from(rawJsonStr, 'utf8'),
      ]);
      const parsedBom = inspectors.parseEpicManifestBuffer(bomPrefixedBuf);
      expect(parsedBom).toEqual({
        diskSize: expectedDiskSize,
        downloadSize: expectedDownloadSize,
      });

      // (c) zlib-compressed JSON manifest buffer
      const zlibCompressedBuf = zlib.deflateSync(bomPrefixedBuf);
      const parsedZlib = inspectors.parseEpicManifestBuffer(zlibCompressedBuf);
      expect(parsedZlib).toEqual({
        diskSize: expectedDiskSize,
        downloadSize: expectedDownloadSize,
      });
    });

    it('preserves backwards compatibility with plain numeric synthetic JSON manifests and rejects corrupt >255 %03d blobs', () => {
      const plainNumericManifest = Buffer.from(
        JSON.stringify({
          FileManifestList: [
            {
              Filename: 'Engine/Binaries/Win64/Game.exe',
              FileChunkParts: [{ Size: 1048576 }, { Size: 2097152 }],
            },
          ],
          ChunkFilesizeList: {
            CHUNK_0: 1572864,
          },
        }),
        'utf8'
      );
      expect(inspectors.parseEpicManifestBuffer(plainNumericManifest)).toEqual({
        diskSize: 3_145_728,
        downloadSize: 1_572_864,
      });

      // Corrupt %03d byte (>255) that would overflow 2 TiB if misread as decimal must return null
      const corruptBlobManifest = Buffer.from(
        JSON.stringify({
          ManifestFileVersion: '013000000000',
          FileManifestList: [
            {
              Filename: 'bad.pak',
              FileChunkParts: [{ Size: '299999999999999' }],
            },
          ],
        }),
        'utf8'
      );
      expect(inspectors.parseEpicManifestBuffer(corruptBlobManifest)).toBeNull();
    });
  });

  // =========================================================================
  // 2. Epic Binary Manifest (0x44BEC00C) Bounds & Multi-Version Accuracy
  // =========================================================================
  describe('2. Epic Binary Manifest (0x44BEC00C) Bounds & Multi-Version Accuracy', () => {
    it('parses Binary v18/v21 (headerSize=41, zlib & uncompressed, multiple InstallTags, UTF-16LE negative FStrings, int64 CDL FileSize)', () => {
      const files: SyntheticFileSpec[] = [
        {
          filename: 'Game/Binaries/Win64/SynthGame-Win64-Shipping.exe',
          installTags: ['core', 'highres_textures', 'voice_en'],
          partSizes: [45_000_000, 12_345_678],
        },
        {
          filename: 'Game/Content/Paks/pakchunk0-WindowsNoEditor_ümlaut.pak',
          utf16Filename: true,
          installTags: [],
          partSizes: [120_000_000],
        },
      ];
      const chunks: SyntheticChunkSpec[] = [
        { windowSize: 1_048_576, fileSize: 38_100_000n },
        { windowSize: 1_048_576, fileSize: 91_200_500n },
      ];

      const compressedV21 = buildSyntheticEpicBinaryManifest({
        headerSize: 41,
        manifestVersion: 21,
        storedAs: 0x01,
        cdlVersion: 0,
        fmlVersion: 0,
        chunks,
        files,
      });
      expect(inspectors.parseEpicManifestBuffer(compressedV21)).toEqual({
        diskSize: 45_000_000 + 12_345_678 + 120_000_000,
        downloadSize: 38_100_000 + 91_200_500,
      });

      const uncompressedV18 = buildSyntheticEpicBinaryManifest({
        headerSize: 41,
        manifestVersion: 18,
        storedAs: 0x00,
        cdlVersion: 0,
        fmlVersion: 0,
        chunks,
        files,
      });
      expect(inspectors.parseEpicManifestBuffer(uncompressedV18)).toEqual({
        diskSize: 177_345_678,
        downloadSize: 129_300_500,
      });
    });

    it('parses Binary v22+ (headerSize=73, CDL trailing FL>=22 bytes, FML v1 and FML v2)', () => {
      const files: SyntheticFileSpec[] = [
        {
          filename: 'UE5Game/Content/Paks/global.utoc',
          installTags: ['base'],
          partSizes: [8_500_000, 4_250_000],
          mimeType: 'application/x-ue5-utoc',
        },
        {
          filename: 'UE5Game/Content/Paks/global.ucas',
          utf16Filename: true,
          installTags: ['base', 'shader_cache'],
          partSizes: [250_000_000],
          mimeType: 'application/x-ue5-ucas',
        },
      ];
      const chunks: SyntheticChunkSpec[] = [
        { windowSize: 1_048_576, fileSize: 180_400_123n },
      ];

      const v22FmlV1 = buildSyntheticEpicBinaryManifest({
        headerSize: 73,
        manifestVersion: 22,
        storedAs: 0x01,
        cdlVersion: 1, // includes trailing 32-byte SHA-256 per chunk
        fmlVersion: 1,
        chunks,
        files,
      });
      expect(inspectors.parseEpicManifestBuffer(v22FmlV1)).toEqual({
        diskSize: 262_750_000,
        downloadSize: 180_400_123,
      });

      const v24FmlV2 = buildSyntheticEpicBinaryManifest({
        headerSize: 73,
        manifestVersion: 24,
        storedAs: 0x01,
        cdlVersion: 1,
        fmlVersion: 2,
        chunks,
        files,
      });
      expect(inspectors.parseEpicManifestBuffer(v24FmlV2)).toEqual({
        diskSize: 262_750_000,
        downloadSize: 180_400_123,
      });
    });

    it('returns null cleanly on encrypted (storedAs=0x03), structSize=0, or truncated FML binary manifests without throwing or looping', () => {
      const baseSpec = {
        chunks: [{ windowSize: 1048576, fileSize: 500000n }],
        files: [{ filename: 'Game.exe', partSizes: [1048576] }],
      };

      // Encrypted manifest (storedAs = 0x03 = compressed + encrypted)
      const encryptedBuf = buildSyntheticEpicBinaryManifest({
        ...baseSpec,
        storedAs: 0x03,
      });
      expect(inspectors.parseEpicManifestBuffer(encryptedBuf)).toBeNull();

      // structSize = 0 inside FChunkPart (would infinite-loop if not guarded by structSize >= 28)
      const zeroStructBuf = buildSyntheticEpicBinaryManifest({
        ...baseSpec,
        overridePartStructSize: 0,
      });
      expect(inspectors.parseEpicManifestBuffer(zeroStructBuf)).toBeNull();

      // Truncated FML body
      const truncatedFmlBuf = buildSyntheticEpicBinaryManifest({
        ...baseSpec,
        truncateFmlByBytes: 12,
      });
      expect(inspectors.parseEpicManifestBuffer(truncatedFmlBuf)).toBeNull();
    });

    it('rejects corrupt runaway manifests (> 2 TiB) and automatically falls back to legendary info --json in getGameInstallInfo', async () => {
      // 2.5 TiB exceeds MAX_PLAUSIBLE_GAME_INSTALL_BYTES (2 TiB)
      const runawayBytes = Math.round(2.5 * 1024 * 1024 * 1024 * 1024);
      expect(inspectors.sanitizeGameInstallSizeBytes(runawayBytes)).toBeUndefined();
      expect(sanitizeClientBytes(runawayBytes)).toBeUndefined();

      // Build a synthetic binary manifest with 700 chunks summing > 2 TiB
      const hugeParts = new Array(700).fill(3_500_000_000); // 700 * 3.5 GB = 2.45 TB > 2 TiB
      const runawayManifestBuf = buildSyntheticEpicBinaryManifest({
        headerSize: 41,
        manifestVersion: 21,
        storedAs: 0x01,
        chunks: [{ windowSize: 1048576, fileSize: 1024n }],
        files: [{ filename: 'corrupt.pak', partSizes: hugeParts }],
      });
      expect(inspectors.parseEpicManifestBuffer(runawayManifestBuf)).toBeNull();

      // End-to-end getGameInstallInfo fallback to legendary info --json
      const sandbox = createSandboxDir('epic-runaway-fallback');
      const homeDir = path.join(sandbox, 'home');
      const userDataDir = path.join(sandbox, 'userdata');
      const legCfgDir = path.join(userDataDir, 'legendaryConfig', 'legendary');
      const manifestsDir = path.join(legCfgDir, 'manifests');
      const mockLegBin = path.join(homeDir, 'bin', 'legendary');

      fs.mkdirSync(manifestsDir, { recursive: true });
      fs.mkdirSync(path.dirname(mockLegBin), { recursive: true });
      fs.writeFileSync(mockLegBin, 'stub', { mode: 0o755 });
      fs.writeFileSync(
        path.join(legCfgDir, 'assets.json'),
        JSON.stringify({
          Windows: [
            {
              app_name: 'synth_runaway_app',
              app_title: 'Synthetic Runaway Title',
              build_version: '1.2.0',
            },
          ],
          Mac: [],
        })
      );
      fs.writeFileSync(
        path.join(manifestsDir, 'synth_runaway_app_Windows_1.2.0.manifest'),
        runawayManifestBuf
      );

      const legendaryCalls: string[][] = [];
      const mockExecFile = (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        legendaryCalls.push(args);
        cb(
          null,
          JSON.stringify({
            game: {
              title: 'Synthetic Runaway Title',
              owned_dlc: [{ manifest: { disk_size: 1_500_000_000 } }],
            },
            manifest: {
              disk_size: 10_969_847_966,
              download_size: 7_412_000_000,
            },
          }),
          ''
        );
      };

      const info = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'epic',
          platformGameId: 'synth_runaway_app',
          title: 'Synthetic Runaway Title',
        },
        {
          platform: 'win32',
          homedir: homeDir,
          userDataDir,
          legendaryBinaryPath: mockLegBin,
          execFileFn: mockExecFile,
        }
      );

      expect(legendaryCalls.length).toBe(1);
      expect(legendaryCalls[0]).toEqual([
        'info',
        'synth_runaway_app',
        '--platform',
        'Windows',
        '--json',
      ]);
      expect(info.estimatedSizeBytes).toBe(10_969_847_966);
      expect(info.downloadSizeBytes).toBe(7_412_000_000);
      expect(info.dlcSizeBytes).toBe(1_500_000_000);
    });
  });

  // =========================================================================
  // 3. Dual-OS (Mac vs Windows) Separation & Multi-Storefront Sizing
  // =========================================================================
  describe('3. Dual-OS (Mac vs Windows) Install Size Separation & Storefront Fallbacks', () => {
    it('resolves Mac and Windows Epic manifests independently on darwin with zero stamp-over', async () => {
      const sandbox = createSandboxDir('epic-dual-os');
      const homeDir = path.join(sandbox, 'home');
      const userDataDir = path.join(sandbox, 'userdata');
      const legCfgDir = path.join(userDataDir, 'legendaryConfig', 'legendary');
      const manifestsDir = path.join(legCfgDir, 'manifests');
      const metaDir = path.join(legCfgDir, 'metadata');

      fs.mkdirSync(manifestsDir, { recursive: true });
      fs.mkdirSync(metaDir, { recursive: true });

      fs.writeFileSync(
        path.join(legCfgDir, 'assets.json'),
        JSON.stringify({
          Mac: [
            {
              app_name: 'dual_os_epic_01',
              app_title: 'Dual OS Odyssey',
              build_version: '2.0.1-mac',
            },
          ],
          Windows: [
            {
              app_name: 'dual_os_epic_01',
              app_title: 'Dual OS Odyssey',
              build_version: '2.0.4-win',
            },
          ],
        })
      );
      fs.writeFileSync(
        path.join(metaDir, 'dual_os_epic_01.json'),
        JSON.stringify({
          app_name: 'dual_os_epic_01',
          app_title: 'Dual OS Odyssey',
          asset_infos: {
            Mac: { app_name: 'dual_os_epic_01', build_version: '2.0.1-mac' },
            Windows: { app_name: 'dual_os_epic_01', build_version: '2.0.4-win' },
          },
          metadata: {
            dlcItemList: [
              {
                releaseInfo: [{ appId: 'dual_os_dlc_01', platform: ['Mac', 'Windows'] }],
              },
            ],
          },
        })
      );

      const macDisk = 4_250_000_000;
      const winDisk = 9_875_000_000;
      const macDlcDisk = 600_000_000;
      const winDlcDisk = 850_000_000;

      const makeSplitParts = (total: number): number[] => {
        const out: number[] = [];
        let rem = total;
        while (rem > 0) {
          const slice = Math.min(rem, 1_500_000_000);
          out.push(slice);
          rem -= slice;
        }
        return out;
      };

      fs.writeFileSync(
        path.join(manifestsDir, 'dual_os_epic_01_Mac_2.0.1-mac.manifest'),
        buildSyntheticEpicBinaryManifest({
          chunks: [{ windowSize: 1048576, fileSize: 2_900_000_000n }],
          files: [{ filename: 'DualOs.app/Contents/MacOS/DualOs', partSizes: makeSplitParts(macDisk) }],
        })
      );
      fs.writeFileSync(
        path.join(manifestsDir, 'dual_os_epic_01_Windows_2.0.4-win.manifest'),
        buildSyntheticEpicBinaryManifest({
          chunks: [{ windowSize: 1048576, fileSize: 6_400_000_000n }],
          files: [{ filename: 'Binaries/Win64/DualOs.exe', partSizes: makeSplitParts(winDisk) }],
        })
      );
      fs.writeFileSync(
        path.join(manifestsDir, 'dual_os_dlc_01_Mac_1.0.manifest'),
        buildSyntheticEpicBinaryManifest({
          chunks: [{ windowSize: 1048576, fileSize: 400_000_000n }],
          files: [{ filename: 'DLC1_Mac.pak', partSizes: [macDlcDisk] }],
        })
      );
      fs.writeFileSync(
        path.join(manifestsDir, 'dual_os_dlc_01_Windows_1.0.manifest'),
        buildSyntheticEpicBinaryManifest({
          chunks: [{ windowSize: 1048576, fileSize: 550_000_000n }],
          files: [{ filename: 'DLC1_Win.pak', partSizes: [winDlcDisk] }],
        })
      );

      const info = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'epic',
          platformGameId: 'dual_os_epic_01',
          title: 'Dual OS Odyssey',
        },
        {
          platform: 'darwin',
          homedir: homeDir,
          userDataDir,
          skipNetwork: true,
        }
      );

      const macInst = info.availableInstallers.find((i: any) => i.id === 'epic-mac-native');
      const winInst = info.availableInstallers.find((i: any) => i.id === 'epic-win-compat');

      expect(macInst).toBeDefined();
      expect(winInst).toBeDefined();
      expect(macInst.totalSizeBytes).toBe(macDisk);
      expect(winInst.totalSizeBytes).toBe(winDisk);
      expect(macInst.totalSizeBytes).not.toBe(winInst.totalSizeBytes);
      expect(macInst.dlcSizeBytes).toBe(macDlcDisk);
      expect(winInst.dlcSizeBytes).toBe(winDlcDisk);
      expect(info.estimatedSizeBytes).toBe(macDisk);
    });

    it('enforces strict Epic storesearch title matching: rejects unrelated items[0] while accepting edition-stripped matches & direct steamAppId', async () => {
      const sandbox = createSandboxDir('epic-storesearch');
      const homeDir = path.join(sandbox, 'home');
      const userDataDir = path.join(sandbox, 'userdata');

      const requestedUrls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requestedUrls.push(url);

        if (url.includes('storesearch') && url.includes('Exclusive%20Racer')) {
          return new Response(
            JSON.stringify({
              items: [{ id: 999111, name: 'Completely Unrelated Racing Manager' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }

        if (url.includes('storesearch') && url.includes('Tactical%20Quest')) {
          return new Response(
            JSON.stringify({
              items: [
                { id: 111000, name: 'Wrong First Result' },
                { id: 888222, name: 'Tactical Quest: Definitive Edition' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }

        if (url.includes('appdetails?appids=888222')) {
          return new Response(
            JSON.stringify({
              '888222': {
                success: true,
                data: {
                  pc_requirements: {
                    minimum: '<li><strong>Storage:</strong> 25 GB available space</li>',
                  },
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }

        if (url.includes('appdetails?appids=777333')) {
          return new Response(
            JSON.stringify({
              '777333': {
                success: true,
                data: {
                  pc_requirements: {
                    minimum: '<li><strong>Storage:</strong> 14 GB available space</li>',
                  },
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }

        return new Response('{}', { status: 404 });
      }) as typeof globalThis.fetch;

      // Case A: Unrelated items[0] MUST be rejected (zero appdetails calls for 999111)
      const resUnrelated = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'epic',
          platformGameId: 'epic_exclusive_racer',
          title: 'Synthetic Exclusive Racer',
        },
        {
          platform: 'win32',
          homedir: homeDir,
          userDataDir,
          disableLegendarySpawn: true,
        }
      );
      expect(resUnrelated.estimatedSizeBytes).toBeUndefined();
      expect(requestedUrls.some((u) => u.includes('999111'))).toBe(false);

      // Case B: Edition-stripped match ("Epic Games Edition" <-> "Definitive Edition") accepted
      const resEdition = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'epic',
          platformGameId: 'epic_tactical_quest',
          title: 'Tactical Quest - Epic Games Edition',
        },
        {
          platform: 'win32',
          homedir: homeDir,
          userDataDir,
          disableLegendarySpawn: true,
        }
      );
      expect(resEdition.estimatedSizeBytes).toBe(25 * 1024 * 1024 * 1024);

      // Case C: Direct steamAppId bypasses storesearch and resolves appdetails directly
      requestedUrls.length = 0;
      const resDirect = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'epic',
          platformGameId: 'epic_direct_steam_id',
          title: 'Direct Steam Mapped Title',
          steamAppId: 777333,
        },
        {
          platform: 'win32',
          homedir: homeDir,
          userDataDir,
          disableLegendarySpawn: true,
        }
      );
      expect(requestedUrls.some((u) => u.includes('storesearch'))).toBe(false);
      expect(resDirect.estimatedSizeBytes).toBe(14 * 1024 * 1024 * 1024);
    });

    it('prioritizes GOG gogdl info uncompressed disk_size over download_size, sums DLCs, and parses Heroic GOG "1.11 GiB" strings', async () => {
      // 1. parseByteCountOrFormattedSize direct checks
      expect(inspectors.parseByteCountOrFormattedSize('1.11 GiB')).toBe(
        Math.round(1.11 * 1024 * 1024 * 1024)
      );
      expect(inspectors.parseByteCountOrFormattedSize('532.4 MiB')).toBe(
        Math.round(532.4 * 1024 * 1024)
      );

      // 2. Heroic GOG installed.json scanner via scanAllInstalledGames
      const sandbox = createSandboxDir('gog-sizing');
      const homeDir = path.join(sandbox, 'home');
      const userDataDir = path.join(sandbox, 'userdata');
      const gogStoreDir = path.join(userDataDir, 'gog_store');
      const portalInstallDir = path.join(sandbox, 'Games', 'Portal2');
      const exePath = path.join(portalInstallDir, 'Portal2.exe');

      fs.mkdirSync(gogStoreDir, { recursive: true });
      fs.mkdirSync(portalInstallDir, { recursive: true });
      fs.writeFileSync(exePath, 'MZ-stub');
      fs.writeFileSync(
        path.join(gogStoreDir, 'installed.json'),
        JSON.stringify({
          installed: [
            {
              appName: '1423000999',
              title: 'Synthetic Portal 2',
              install_path: portalInstallDir,
              executable: exePath,
              install_size: '1.11 GiB',
              platform: 'windows',
              version: '1.02',
            },
          ],
        })
      );

      const scanned = await launcherEngine.scanAllInstalledGames({
        platform: 'win32',
        homedir: homeDir,
        userDataDir,
        skipFirstPartySync: true,
      });
      const portalRec = scanned.installedGames.find(
        (r: any) => r.platformId === 'gog' && r.platformGameId === '1423000999'
      );
      expect(portalRec).toBeDefined();
      expect(portalRec.installSize).toBe(Math.round(1.11 * 1024 * 1024 * 1024));

      // 3. GOG gogdl info fallback in getGameInstallInfo: disk_size > download_size + dlcSizeBytes
      const gogAuthPath = path.join(gogStoreDir, 'auth.json');
      const mockGogdlBin = path.join(homeDir, 'bin', 'gogdl');
      fs.mkdirSync(path.dirname(mockGogdlBin), { recursive: true });
      fs.writeFileSync(mockGogdlBin, 'stub', { mode: 0o755 });
      fs.writeFileSync(
        gogAuthPath,
        JSON.stringify({
          '46899977096215655': {
            access_token: 'valid_synthetic_gog_oauth_token_12345',
            refresh_token: 'valid_synthetic_gog_refresh_token_12345',
            user_id: '900000001',
          },
        })
      );

      // Simulate api.gog.com/products returning compressed offline .exe installer size (3.53 GiB),
      // while gogdl info returns uncompressed Content System v2 depot sizes ("*" + "en-US" = 4.51 GiB).
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('api.gog.com/products/1947927225')) {
          return new Response(
            JSON.stringify({
              downloads: {
                installers: [
                  {
                    id: 'en1installer0',
                    name: 'Synthetic Quake II Remaster',
                    os: 'windows',
                    language: 'en',
                    total_size: 3_787_456_512, // Compressed offline .exe backup size (~3.53 GiB)
                    version: 'update_2_1',
                  },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('{}', { status: 404 });
      }) as typeof globalThis.fetch;

      const mockGogdlExec = (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        const platIdx = args.indexOf('--platform');
        const osFlag = platIdx >= 0 ? args[platIdx + 1] : 'windows';
        if (osFlag === 'windows') {
          cb(
            null,
            JSON.stringify({
              size: {
                '*': { download_size: 208, disk_size: 480 },
                'en-US': { download_size: 3_729_750_320, disk_size: 4_837_509_036 },
              },
              dlcs: [
                { disk_size: 512_000_000, download_size: 380_000_000 },
                {
                  size: {
                    '*': { disk_size: 6_000_000, download_size: 4_000_000 },
                    en: { disk_size: 250_000_000, download_size: 186_000_000 },
                  },
                },
              ],
            }),
            ''
          );
        } else {
          cb(null, '', 'No mac build');
        }
      };

      const gogInfo = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'gog',
          platformGameId: '1947927225',
          title: 'Synthetic Quake II Remaster',
          storePlatforms: { windows: true, mac: false },
        },
        {
          platform: 'darwin',
          homedir: homeDir,
          userDataDir,
          gogAuthPath,
          savedTokens: {
            gog: {
              access_token: 'valid_synthetic_gog_oauth_token_12345',
              refresh_token: 'valid_synthetic_gog_refresh_token_12345',
              user_id: '900000001',
            },
          },
          gogAccessToken: 'valid_synthetic_gog_oauth_token_12345',
          gogdlBinaryPath: mockGogdlBin,
          execFileFn: mockGogdlExec,
        }
      );

      expect(gogInfo.estimatedSizeBytes).toBe(4_837_509_036 + 480);
      expect(gogInfo.downloadSizeBytes).toBe(3_729_750_320 + 208);
      expect(gogInfo.dlcSizeBytes).toBe(768_000_000);
      expect(gogInfo.availableInstallers[0].totalSizeBytes).toBe(4_837_509_036 + 480);
      expect(gogInfo.availableInstallers[0].downloadSizeBytes).toBe(3_729_750_320 + 208);
      expect(gogInfo.availableInstallers[0].dlcSizeBytes).toBe(768_000_000);
    });

    it('separates Steam mac_requirements vs pc_requirements on darwin and parses Steam ACF SizeOnDisk', async () => {
      const acfParsed = inspectors.parseSteamAcf(`"AppState"
{
\t"appid"\t\t"550999"
\t"Universe"\t\t"1"
\t"name"\t\t"Synthetic Dual OS RPG"
\t"StateFlags"\t\t"4"
\t"installdir"\t\t"Synthetic Dual OS RPG"
\t"SizeOnDisk"\t\t"19327352832"
}`);
      expect(acfParsed?.appId).toBe(550999);
      expect(acfParsed?.SizeOnDisk).toBe('19327352832');

      const sandbox = createSandboxDir('steam-dual-os');
      const homeDir = path.join(sandbox, 'home');
      const userDataDir = path.join(sandbox, 'userdata');

      const steamInfo = await launcherEngine.getGameInstallInfo(
        {
          platformId: 'steam',
          platformGameId: '550999',
          steamAppId: 550999,
          title: 'Synthetic Dual OS RPG',
        },
        {
          platform: 'darwin',
          homedir: homeDir,
          userDataDir,
          skipNetwork: true,
          mockSteamAppDetails: {
            platforms: { mac: true, windows: true },
            mac_requirements: {
              minimum: '<li><strong>Storage:</strong> 18 GB available space</li>',
            },
            pc_requirements: {
              minimum: '<li><strong>Storage:</strong> 42 GB available space</li>',
            },
          },
        }
      );

      const macSteam = steamInfo.availableInstallers.find((i: any) => i.id === 'steam-mac-native');
      const winSteam = steamInfo.availableInstallers.find((i: any) => i.id === 'steam-win-compat');

      expect(macSteam).toBeDefined();
      expect(winSteam).toBeDefined();
      expect(macSteam.totalSizeBytes).toBe(18 * 1024 * 1024 * 1024);
      expect(winSteam.totalSizeBytes).toBe(42 * 1024 * 1024 * 1024);
      expect(steamInfo.estimatedSizeBytes).toBe(18 * 1024 * 1024 * 1024);
    });
  });

  // =========================================================================
  // 4. Universal HTML Storage Requirement Parser Torture Suite
  // =========================================================================
  describe('4. Universal HTML Storage Requirement Parser Torture Suite (Backend & Client 1:1 Parity)', () => {
    const MiB = 1024 * 1024;
    const GiB = 1024 * 1024 * 1024;

    it.each([
      {
        label: 'thousands-separator comma with Hard Drive label',
        html: '<li><strong>Hard Drive:</strong> 1,650 MB<br></li>',
        expectedBytes: 1650 * MiB,
        expectedText: '1.6 GB',
      },
      {
        label: 'thousands-separator comma before free hard disk space',
        html: '3,000 MB free hard disk space',
        expectedBytes: 3000 * MiB,
        expectedText: '2.9 GB',
      },
      {
        label: 'European decimal comma with German Speicherplatz label',
        html: 'Speicherplatz: 4,5 GB verfügbarer Speicherplatz',
        expectedBytes: Math.round(4.5 * GiB),
        expectedText: '4.5 GB',
      },
      {
        label: 'parenthetical Windows swap-file exclusion (DOOM 3: RoE style)',
        html: '<strong>Minimum: </strong>384 MB RAM, 2.2GB of uncompressed free hard disk space (plus 400MB for Windows® swap file)',
        expectedBytes: Math.round(2.2 * GiB),
        expectedText: '2.2 GB',
      },
      {
        label: 'split HTML heading and paragraph tags',
        html: '<h4>Storage</h4><p>45 GB</p>',
        expectedBytes: 45 * GiB,
        expectedText: '45.0 GB',
      },
      {
        label: 'inline SSD token between number and GB unit (Witcher 3 style)',
        html: '<li><strong>Storage:</strong> 60 SSD GB available space<br></li>',
        expectedBytes: 60 * GiB,
        expectedText: '60.0 GB',
      },
      {
        label: 'classic uncompressed hard drive space phrasing',
        html: '150MB uncompressed hard drive space',
        expectedBytes: 150 * MiB,
        expectedText: '150 MB',
      },
      {
        label: 'classic Free HDD space phrasing',
        html: '1.7 GB Free HDD space',
        expectedBytes: Math.round(1.7 * GiB),
        expectedText: '1.7 GB',
      },
      {
        label: 'normalized 10000 MB -> 9.8 GB conversion',
        html: 'Storage: 10000 MB available space',
        expectedBytes: 10000 * MiB,
        expectedText: '9.8 GB',
      },
    ])('parses $label identically in backend and client', ({ html, expectedBytes, expectedText }) => {
      expect(inspectors.parseStorageRequirementBytes(html)).toBe(expectedBytes);
      expect(parseStorageRequirementBytesClient(html)).toBe(expectedBytes);
      expect(parseStorageRequirementTextClient(html)).toBe(expectedText);
    });

    it('excludes non-storage Graphics VRAM ("Storage Space" typo) and RAM lines without false positives', () => {
      const nonStorageHtml =
        '<li><strong>Graphics:</strong> Any Graphics card with more than 2GB of Storage Space.</li><li><strong>Memory:</strong> 16 GB RAM</li>';
      expect(inspectors.parseStorageRequirementBytes(nonStorageHtml)).toBeUndefined();
      expect(parseStorageRequirementBytesClient(nonStorageHtml)).toBeUndefined();
      expect(parseStorageRequirementTextClient(nonStorageHtml)).toBeNull();
    });

    it('preserves multi-TB drive capacities in formatBytes while rejecting > 2 TiB in sanitizeGameInstallSizeBytes', () => {
      const fourTbDrive = 4 * 1024 * 1024 * 1024 * 1024;
      expect(formatBytes(fourTbDrive)).toBe('4.00 TB');
      expect(formatByteSize(fourTbDrive)).toBe('4.00 TB');

      const poisonedPcbsBytes = Math.round(253114.6 * GiB);
      expect(poisonedPcbsBytes).toBeGreaterThan(MAX_PLAUSIBLE_GAME_INSTALL_BYTES);
      expect(sanitizeClientBytes(poisonedPcbsBytes)).toBeUndefined();
      expect(inspectors.sanitizeGameInstallSizeBytes(poisonedPcbsBytes)).toBeUndefined();
    });
  });

  // =========================================================================
  // 5. Catalog Persistence Sanitization & Stale Uninstall Cleanup
  // =========================================================================
  describe('5. Catalog Persistence Sanitization & Stale Uninstall Cleanup (integrationStorage.ts)', () => {
    it('strips stale installSize on uninstall and strips poisoned > 2 TiB installSize in reconcileCatalogGamesWithInstalledRecords', () => {
      const poisonedSize = 271_779_732_258_816; // ~253,114.6 GB

      const staleUninstalledCatalog: CanonicalGame[] = [
        makeSyntheticGame({
          id: 'epic-uninstalled-1',
          platforms: [
            {
              platformId: 'epic',
              platformGameId: 'synth_app_uninstalled',
              installed: true,
              installPath: path.join(os.tmpdir(), 'OldInstall'),
              executablePath: path.join(os.tmpdir(), 'OldInstall', 'Game.exe'),
              installSize: 12_500_000_000,
              playtimeMinutes: 45,
            },
          ],
        }),
        makeSyntheticGame({
          id: 'epic-installed-poisoned',
          platforms: [
            {
              platformId: 'epic',
              platformGameId: 'synth_app_poisoned',
              installed: true,
              installPath: path.join(os.tmpdir(), 'LiveInstall'),
              installSize: poisonedSize,
              playtimeMinutes: 10,
            },
          ],
        }),
      ];

      const reconciled = reconcileCatalogGamesWithInstalledRecords(
        staleUninstalledCatalog,
        [
          {
            platformId: 'epic',
            platformGameId: 'synth_app_poisoned',
            title: 'Poisoned Installed Game',
            installPath: path.join(os.tmpdir(), 'LiveInstall'),
            installSize: poisonedSize,
          },
        ],
        { authoritativeRemoval: true }
      );

      // Uninstalled game must have installed: false and installSize completely stripped
      expect(reconciled[0].platforms[0].installed).toBe(false);
      expect(reconciled[0].platforms[0].installSize).toBeUndefined();
      expect(reconciled[0].platforms[0].installPath).toBeUndefined();

      // Installed game with > 2 TiB poisoned size must have poisoned installSize stripped
      expect(reconciled[1].platforms[0].installed).toBe(true);
      expect(reconciled[1].platforms[0].installSize).toBeUndefined();
    });

    it('never resurrects installSize onto uninstalled (installed: false) platform entries in preserveLocalInstallFieldsAcrossSanitize or loadCurrentCatalog', () => {
      const sourceWithStaleAndPoisoned: CanonicalGame[] = [
        makeSyntheticGame({
          id: 'epic-uninstalled-stale',
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: 'stale_app_01',
              installed: false,
              installSize: 271_779_732_258_816, // poisoned > 2 TiB on uninstalled
              version: '1.0.4',
              playtimeMinutes: 0,
            },
          ],
        }),
        makeSyntheticGame({
          id: 'gog-uninstalled-valid-num',
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'gog',
              platformGameId: '1999888777',
              installed: false,
              installSize: 8_589_934_592, // 8 GiB stale on uninstalled
              version: '2.1',
              playtimeMinutes: 0,
            },
          ],
        }),
      ];

      const sanitizedTarget: CanonicalGame[] = [
        makeSyntheticGame({
          id: 'epic-uninstalled-stale',
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: 'stale_app_01',
              installed: false,
              installSize: 271_779_732_258_816,
              playtimeMinutes: 0,
            },
          ],
        }),
        makeSyntheticGame({
          id: 'gog-uninstalled-valid-num',
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'gog',
              platformGameId: '1999888777',
              installed: false,
              playtimeMinutes: 0,
            },
          ],
        }),
      ];

      const preserved = preserveLocalInstallFieldsAcrossSanitize(
        sourceWithStaleAndPoisoned,
        sanitizedTarget
      );
      expect(preserved[0].platforms[0].installed).toBe(false);
      expect(preserved[0].platforms[0].installSize).toBeUndefined();
      expect(preserved[1].platforms[0].installed).toBe(false);
      expect(preserved[1].platforms[0].installSize).toBeUndefined();

      // Also verify loadCurrentCatalog cleans poisoned installSize persisted in localStorage
      localStorage.setItem(
        'universal_game_library_catalog',
        JSON.stringify(sourceWithStaleAndPoisoned)
      );
      const loaded = loadCurrentCatalog();
      const loadedEpic = loaded.find((g) => g.id === 'epic-uninstalled-stale');
      expect(loadedEpic?.platforms[0].installSize).toBeUndefined();
    });
  });

  // =========================================================================
  // 6. UI Components (SteamLibraryActionBar & GameInstallModal)
  // =========================================================================
  describe('6. UI Components (SteamLibraryActionBar & GameInstallModal Disk-Space & DLC Accuracy)', () => {
    it('SteamLibraryActionBar queries getGameInstallInfo on uninstalled games even with stale installSize and never renders 253114.6 GB', async () => {
      const poisonedGame = makeSyntheticGame({
        id: 'epic-pcbs-regression',
        title: 'Synthetic PC Building Sim',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'synth_pcbs_id',
            installed: false,
            installSize: 271_779_732_258_816, // 253,114.6 GB poisoned cache
            playtimeMinutes: 0,
          },
        ],
      });

      const getInstallInfoSpy = vi
        .spyOn(launcherService, 'getGameInstallInfo')
        .mockResolvedValue({
          platformId: 'epic',
          platformGameId: 'synth_pcbs_id',
          estimatedSizeBytes: 10_969_847_966, // 10.2 GB ground truth
          defaultInstallDir: '~/Games/OneLauncher',
          availableInstallDirs: ['~/Games/OneLauncher'],
          availableInstallers: [
            {
              id: 'epic-win-compat',
              name: 'Windows Build',
              os: 'windows',
              totalSizeBytes: 10_969_847_966,
            },
          ],
          canDirectDownload: true,
          requiresStoreClientFallback: false,
        });
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(false);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue(undefined);

      const harness = createComponentHarness(SteamLibraryActionBar, {
        game: poisonedGame,
        collections: [],
      });

      let tree = harness.render();
      expect(getTextContent(tree)).not.toContain('253114.6');
      expect(getTextContent(tree)).not.toContain('247.29 TB');
      expect(getInstallInfoSpy).toHaveBeenCalledTimes(1);

      await flushMicrotasks();
      tree = harness.render();
      const text = getTextContent(tree);
      expect(text).toContain('10.2 GB');
      expect(text).not.toContain('253114.6');
      harness.unmount();
    });

    it('SteamLibraryActionBar resolves Space Required from macRequirements when PC requirements only mention Graphics VRAM "Storage Space"', async () => {
      const macFallbackGame = makeSyntheticGame({
        id: 'steam-mac-req-fallback',
        steamAppId: 1627840,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1627840',
            installed: false,
            playtimeMinutes: 0,
          },
        ],
      });

      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '1627840',
        estimatedSizeBytes: undefined,
        defaultInstallDir: '~/Library/Application Support/Steam/steamapps/common',
        availableInstallDirs: ['~/Library/Application Support/Steam/steamapps/common'],
        availableInstallers: [],
        canDirectDownload: false,
        requiresStoreClientFallback: true,
      });
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(false);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue(undefined);

      const harness = createComponentHarness(SteamLibraryActionBar, {
        game: macFallbackGame,
        collections: [],
        metadata: {
          appId: 1627840,
          name: 'Synthetic Narrative Adventure',
          shortDescription: 'Adventure game.',
          detailedDescription: '',
          aboutTheGame: '',
          headerImage: '',
          developers: ['Dev'],
          publishers: ['Pub'],
          releaseDate: '2023',
          genres: ['Adventure'],
          tags: ['Indie'],
          categories: [],
          screenshots: [],
          movies: [],
          systemRequirements: {
            minimum:
              '<li><strong>Graphics:</strong> Any Graphics card with more than 2GB of Storage Space.</li>',
          },
          macRequirements: {
            minimum: '<li><strong>Storage:</strong> 1 GB available space</li>',
          },
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 100,
            totalNegative: 5,
            totalReviews: 105,
            positivePercent: 95,
          },
        },
      });

      const tree = harness.render();
      const text = getTextContent(tree);
      expect(text).toContain('1.0 GB');
      expect(text).not.toContain('2.0 GB');
      harness.unmount();
    });

    it('GameInstallModal incorporates dlcSizeBytes into Estimated Size when Include Owned DLCs & Expansions is toggled', async () => {
      const baseBytes = 10 * 1024 * 1024 * 1024; // 10.0 GB
      const dlcBytes = Math.round(2.5 * 1024 * 1024 * 1024); // 2.5 GB
      const epicGame = makeSyntheticGame({
        id: 'epic-dlc-toggle-test',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'epic_dlc_game',
            installed: false,
            playtimeMinutes: 0,
          },
        ],
      });

      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'epic',
        platformGameId: 'epic_dlc_game',
        estimatedSizeBytes: baseBytes,
        dlcSizeBytes: dlcBytes,
        defaultInstallDir: '~/Games/OneLauncher',
        availableInstallDirs: ['~/Games/OneLauncher'],
        availableInstallers: [
          {
            id: 'epic-mac-native',
            name: 'Native macOS Build',
            os: 'mac',
            totalSizeBytes: baseBytes,
            dlcSizeBytes: dlcBytes,
          },
        ],
        canDirectDownload: true,
        requiresStoreClientFallback: false,
        diskSpace: {
          targetPath: '~/Games/OneLauncher',
          freeBytes: 80 * 1024 * 1024 * 1024,
          totalBytes: 500 * 1024 * 1024 * 1024,
          usedBytes: 420 * 1024 * 1024 * 1024,
        },
      } as GameInstallInfo);

      const harness = createComponentHarness(GameInstallModal, {
        isOpen: true,
        game: epicGame,
        initialPlatformId: 'epic',
        onClose: vi.fn(),
      });

      harness.render();
      await flushMicrotasks();
      let tree = harness.render();

      // Default for Epic: includeDlcs === true -> 10.0 GB + 2.5 GB = 12.5 GB
      expect(getTextContent(tree)).toContain('Estimated Size: 12.5 GB');
      expect(getTextContent(tree)).toContain('+2.5 GB');

      // Toggle Include Owned DLCs OFF -> Estimated Size drops to 10.0 GB
      const dlcCheckbox = findElements(
        tree,
        (el) => el.type === 'input' && el.props?.['data-testid'] === 'toggle-include-dlcs'
      )[0];
      expect(dlcCheckbox).toBeDefined();
      expect(dlcCheckbox.props.checked).toBe(true);

      dlcCheckbox.props.onChange({ target: { checked: false } });
      tree = harness.render();
      expect(getTextContent(tree)).toContain('Estimated Size: 10.0 GB');

      harness.unmount();
    });

    it('GameInstallModal renders non-blocking amber status advisory and keeps Start Download & Install enabled for Steam low default-drive space', async () => {
      const steamGame = makeSyntheticGame({
        id: 'steam-low-default-drive',
        steamAppId: 440111,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '440111',
            installed: false,
            playtimeMinutes: 0,
          },
        ],
      });

      const lowSteamDisk = {
        targetPath: '/Synthetic/Steam/steamapps/common',
        freeBytes: 4 * 1024 * 1024 * 1024, // 4 GB free
        totalBytes: 100 * 1024 * 1024 * 1024,
        usedBytes: 96 * 1024 * 1024 * 1024,
      };

      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue(lowSteamDisk);
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'steam',
        platformGameId: '440111',
        estimatedSizeBytes: 25 * 1024 * 1024 * 1024, // 25 GB required > 4 GB free
        defaultInstallDir: '/Synthetic/Steam/steamapps/common',
        availableInstallDirs: ['/Synthetic/Steam/steamapps/common'],
        availableInstallers: [
          {
            id: 'steam-mac-native',
            name: 'Steam Client — Native OS',
            os: 'mac',
            totalSizeBytes: 25 * 1024 * 1024 * 1024,
          },
        ],
        canDirectDownload: false,
        requiresStoreClientFallback: true,
        diskSpace: lowSteamDisk,
      });

      const harness = createComponentHarness(GameInstallModal, {
        isOpen: true,
        game: steamGame,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });

      harness.render();
      await flushMicrotasks();
      const tree = harness.render();

      const statusBanner = findElements(
        tree,
        (el) => el.props?.role === 'status' && el.props?.['aria-live'] === 'polite'
      )[0];
      expect(statusBanner).toBeDefined();
      expect(getTextContent(statusBanner)).toContain(
        'Default library volume has less free space than estimated'
      );

      // Must NOT render blocking role="alert"
      const blockingAlerts = findElements(tree, (el) => el.props?.role === 'alert');
      expect(blockingAlerts).toHaveLength(0);

      // Start Download & Install button MUST remain enabled
      const startBtn = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
      )[0];
      expect(startBtn).toBeDefined();
      expect(startBtn.props.disabled).toBe(false);

      harness.unmount();
    });

    it('GameInstallModal renders blocking red role="alert" and disables Start Download & Install when direct-download volume lacks space or has volumeMissing: true', async () => {
      const gogGame = makeSyntheticGame({
        id: 'gog-insufficient-space',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1888777666',
            installed: false,
            playtimeMinutes: 0,
          },
        ],
      });

      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([]);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      const getDiskSpaceSpy = vi.spyOn(launcherService, 'getDiskSpace');

      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        platformId: 'gog',
        platformGameId: '1888777666',
        estimatedSizeBytes: 30 * 1024 * 1024 * 1024, // 30 GB
        defaultInstallDir: '/Synthetic/Games',
        availableInstallDirs: ['/Synthetic/Games'],
        availableInstallers: [
          {
            id: 'gog-mac-native',
            name: 'Native macOS Build',
            os: 'mac',
            totalSizeBytes: 30 * 1024 * 1024 * 1024,
          },
        ],
        canDirectDownload: true,
        requiresStoreClientFallback: false,
        diskSpace: {
          targetPath: '/Synthetic/Games',
          freeBytes: 8 * 1024 * 1024 * 1024, // Only 8 GB free
          totalBytes: 100 * 1024 * 1024 * 1024,
          usedBytes: 92 * 1024 * 1024 * 1024,
        },
      });

      const harness = createComponentHarness(GameInstallModal, {
        isOpen: true,
        game: gogGame,
        initialPlatformId: 'gog',
        onClose: vi.fn(),
      });

      harness.render();
      await flushMicrotasks();
      let tree = harness.render();

      // (a) Insufficient free space -> blocking red role="alert" + button disabled
      let alerts = findElements(tree, (el) => el.props?.role === 'alert');
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(getTextContent(alerts[0])).toContain(
        'Insufficient disk space on target volume for this installation.'
      );

      let startBtn = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
      )[0];
      expect(startBtn.props.disabled).toBe(true);

      // (b) Switch to an unmounted volume (volumeMissing: true) -> blocking red alert + "Not Mounted" + button disabled
      getDiskSpaceSpy.mockResolvedValueOnce({
        targetPath: '/Volumes/DisconnectedDrive/Games',
        freeBytes: 0,
        totalBytes: 0,
        usedBytes: 0,
        volumeMissing: true,
      } as any);

      const dirInput = findElements(
        tree,
        (el) => el.type === 'input' && el.props?.type === 'text'
      )[0];
      await dirInput.props.onChange({ target: { value: '/Volumes/DisconnectedDrive/Games' } });
      await flushMicrotasks();
      tree = harness.render();

      expect(getTextContent(tree)).toContain('Not Mounted');
      alerts = findElements(tree, (el) => el.props?.role === 'alert');
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(getTextContent(alerts[0])).toContain(
        'Selected target drive or volume is not currently mounted.'
      );

      startBtn = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
      )[0];
      expect(startBtn.props.disabled).toBe(true);

      harness.unmount();
    });
  });
});
