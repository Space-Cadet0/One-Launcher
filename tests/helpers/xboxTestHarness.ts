import React from 'react';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import type { CanonicalGame } from '../../src/contracts/game';
import {
  buildSanitizedFragmentViaDomParser,
  sanitizeHtmlStringViaDomParser,
} from './domParserHelper';

export { sanitizeHtmlStringViaDomParser };

export const nodeRequire = createRequire(import.meta.url);

export const xboxAuthManager = nodeRequire('../../electron/storefronts/xbox/xboxAuthManager.cjs');
export const xboxBoringSslCrypto = nodeRequire('../../electron/storefronts/xbox/xboxBoringSslCrypto.cjs');
export const xboxDeviceClep = nodeRequire('../../electron/storefronts/xbox/xboxDeviceClep.cjs');
export const xboxCatalogAndGamePass = nodeRequire('../../electron/storefronts/xbox/xboxCatalogAndGamePass.cjs');
export const xboxAchievementsAndStats = nodeRequire('../../electron/storefronts/xbox/xboxAchievementsAndStats.cjs');
export const msixvcXvdParser = nodeRequire('../../electron/storefronts/xbox/msixvcXvdParser.cjs');
export const msixvcStreamExtractor = nodeRequire('../../electron/storefronts/xbox/msixvcStreamExtractor.cjs');
export const xboxRuntimeLoopbackServer = nodeRequire('../../electron/storefronts/xbox/xboxRuntimeLoopbackServer.cjs');
export const xboxTitleStorageSync = nodeRequire('../../electron/storefronts/xbox/xboxTitleStorageSync.cjs');
export const tokenVault = nodeRequire('../../electron/storefronts/tokenVault.cjs');
export const binaryAndManifestInspectors = nodeRequire('../../electron/launcher/binaryAndManifestInspectors.cjs');
export const cjsLaunchPolicyResolver = nodeRequire('../../electron/launcher/launchPolicyResolver.cjs');
export const uninstallSafety = nodeRequire('../../electron/launcher/uninstallSafety.cjs');
export const cloudSaveEngine = nodeRequire('../../electron/launcher/cloudSaveEngine.cjs');
export const wineAndCrossOverManager = nodeRequire('../../electron/launcher/wineAndCrossOverManager.cjs');
export const offlineVaultMod = nodeRequire('../../electron/launcher/offlineVaultService.cjs');
export const federatorMod = nodeRequire('../../electron/launcher/storefrontLocalCacheFederator.cjs');
export const launcherEngine = nodeRequire('../../electron/launcherEngine.cjs');
export const buildXboxBridge = nodeRequire('../../scripts/build-xbox-bridge.cjs');

let currentDomPurifyFragmentBuilder: ((html: string) => unknown) | null = null;
export function setDomPurifyFragmentBuilder(fn: ((html: string) => unknown) | null): void {
  currentDomPurifyFragmentBuilder = fn;
}
export function getDomPurifyFragmentBuilder(): ((html: string) => unknown) | null {
  return currentDomPurifyFragmentBuilder;
}

export function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

export function makeCanonicalGameFixture(
  partial: Partial<CanonicalGame> & Pick<CanonicalGame, 'id' | 'title' | 'platforms'>
): CanonicalGame {
  return {
    sortTitle: partial.title,
    headerImage: '',
    developers: ['Synthetic Studio'],
    publishers: ['Synthetic Publisher'],
    genres: ['Action'],
    tags: [],
    ...partial,
  };
}

export interface SyntheticSegmentFile {
  path: string;
  data: Buffer;
}

export interface SyntheticMsixvcOptions {
  vduidGuid?: string;
  contentIdGuid?: string;
  keyGuid?: string;
  cik32?: Buffer | null;
  regionIdInXts?: boolean;
  gameConfigXml?: string | null;
  appxManifestXml?: string | null;
  files?: SyntheticSegmentFile[];
}

export function buildValidMinimalPe64Buffer(markerText = 'SYNTHETIC-PE64-PAYLOAD'): Buffer {
  const markerBytes = Buffer.from(markerText, 'utf8');
  const buf = Buffer.alloc(Math.max(256, 0x90 + markerBytes.length), 0);
  // DOS Header: 'MZ' at 0x00, e_lfanew = 0x80 at 0x3c
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  buf.writeUInt32LE(0x80, 0x3c);
  // NT Header: 'PE\0\0' at 0x80, Machine = 0x8664 (IMAGE_FILE_MACHINE_AMD64) at 0x84
  buf[0x80] = 0x50;
  buf[0x81] = 0x45;
  buf[0x82] = 0x00;
  buf[0x83] = 0x00;
  buf.writeUInt16LE(0x8664, 0x84);
  markerBytes.copy(buf, 0x90);
  return buf;
}

export function buildSyntheticSpLicenseBlockBase64(options: {
  deviceKey16: Buffer;
  licenseIdGuid?: string;
  packageFullName?: string;
  contentKeys?: Array<{ keyIdGuid: string; cik32: Buffer }>;
}): string {
  const tlvChunks: Buffer[] = [];
  const pushTlv = (blockId: number, payload: Buffer) => {
    const hdr = Buffer.alloc(8);
    hdr.writeUInt32LE(blockId >>> 0, 0);
    hdr.writeUInt32LE(payload.length >>> 0, 4);
    tlvChunks.push(hdr, payload);
  };

  if (options.licenseIdGuid) {
    pushTlv(
      xboxDeviceClep.BLOCK_ID.LICENSE_ID,
      xboxDeviceClep.encodeMixedEndianGuid(options.licenseIdGuid)
    );
  }
  if (options.packageFullName) {
    pushTlv(
      xboxDeviceClep.BLOCK_ID.PACKAGE_FULL_NAME,
      Buffer.from(`${options.packageFullName}\0`, 'utf16le')
    );
  }
  if (options.contentKeys && options.contentKeys.length > 0) {
    const entryBuffers: Buffer[] = [];
    for (const k of options.contentKeys) {
      const guid16 = xboxDeviceClep.encodeMixedEndianGuid(k.keyIdGuid);
      const wrapped40 = xboxDeviceClep.wrapContentCik(k.cik32, options.deviceKey16);
      const entry = Buffer.alloc(4 + guid16.length + wrapped40.length);
      entry.writeUInt16LE(guid16.length, 0);
      entry.writeUInt16LE(wrapped40.length, 2);
      guid16.copy(entry, 4);
      wrapped40.copy(entry, 4 + guid16.length);
      entryBuffers.push(entry);
    }
    pushTlv(xboxDeviceClep.BLOCK_ID.PACKED_CONTENT_KEYS, Buffer.concat(entryBuffers));
  }

  const header8 = Buffer.alloc(8);
  header8.writeUInt32LE(1, 0);
  header8.writeUInt32LE(8, 4);

  const unsignedSlice = Buffer.concat([header8, ...tlvChunks]);
  const cmacTag16 = xboxDeviceClep.aes128Cmac(options.deviceKey16, unsignedSlice);
  const cmacHdr = Buffer.alloc(8);
  cmacHdr.writeUInt32LE(xboxDeviceClep.BLOCK_ID.CMAC_SIGNATURE, 0);
  cmacHdr.writeUInt32LE(cmacTag16.length, 4);

  return Buffer.concat([unsignedSlice, cmacHdr, cmacTag16]).toString('base64');
}

export function buildSyntheticSegmentMetadata(files: SyntheticSegmentFile[], pduidGuid: string): Buffer {
  const headerLength = 64;
  const pathChunks: Buffer[] = [];
  const pathMeta: Array<{ codeUnits: number; relByteOffset: number }> = [];
  let pathByteCursor = 0;

  for (const f of files) {
    const encoded = Buffer.from(`${f.path}\0`, 'utf16le');
    pathMeta.push({
      codeUnits: f.path.length,
      relByteOffset: pathByteCursor,
    });
    pathChunks.push(encoded);
    pathByteCursor += encoded.length;
  }

  const pathsTable = Buffer.concat(pathChunks);
  const rawTotal = headerLength + files.length * 16 + pathsTable.length;
  const buf = Buffer.alloc(Math.max(128, rawTotal), 0);

  buf.write(' PFX', 0, 'ascii');
  buf.writeUInt32LE(0, 0x04); // version0
  buf.writeUInt32LE(1, 0x08); // version1
  buf.writeUInt32LE(headerLength, 0x0c);
  buf.writeUInt32LE(files.length, 0x10);
  buf.writeUInt32LE(pathsTable.length, 0x14);
  msixvcXvdParser.writeGuidLE(pduidGuid, buf, 0x18);

  for (let i = 0; i < files.length; i += 1) {
    const recOff = headerLength + i * 16;
    buf.writeUInt16LE(0, recOff + 0x00); // flags
    buf.writeUInt16LE(pathMeta[i].codeUnits, recOff + 0x02);
    buf.writeUInt32LE(pathMeta[i].relByteOffset, recOff + 0x04);
    buf.writeBigUInt64LE(BigInt(files[i].data.length), recOff + 0x08);
  }

  pathsTable.copy(buf, headerLength + files.length * 16);
  return buf;
}

export function buildSyntheticUserData(
  packageFullName: string,
  entries: Array<{ name: string; data: Buffer }>
): Buffer {
  const headerLen = 16;
  const pkgHeaderLen = 528;
  const tableBytes = entries.length * 528;
  const payloadBytes = entries.reduce((acc, e) => acc + e.data.length, 0);
  const buf = Buffer.alloc(headerLen + pkgHeaderLen + tableBytes + payloadBytes, 0);

  // XvdUserDataHeader (16B)
  buf.writeUInt32LE(headerLen, 0);
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(0, 8); // type = PackageFiles
  buf.writeUInt32LE(0, 12);

  // PackageFilesHeader (528B at +16)
  buf.writeUInt32LE(1, headerLen);
  Buffer.from(`${packageFullName}\0`, 'utf16le').copy(buf, headerLen + 4, 0, 520);
  buf.writeUInt32LE(entries.length, headerLen + 524);

  // PackageFileEntry[] (528B each at +16 + 528)
  // Note: entry.offset is relative to userDataStart + 16!
  let relDataCursor = pkgHeaderLen + tableBytes;
  for (let i = 0; i < entries.length; i += 1) {
    const eOff = headerLen + pkgHeaderLen + i * 528;
    Buffer.from(`${entries[i].name}\0`, 'utf16le').copy(buf, eOff, 0, 520);
    buf.writeUInt32LE(entries[i].data.length, eOff + 520);
    buf.writeUInt32LE(relDataCursor, eOff + 524);
    entries[i].data.copy(buf, headerLen + relDataCursor);
    relDataCursor += entries[i].data.length;
  }

  return buf;
}

export function buildSyntheticMsixvcImage(options: SyntheticMsixvcOptions = {}): Buffer {
  const vduidGuid = options.vduidGuid || '11223344-5566-7788-99aa-bbccddeeff00';
  const contentIdGuid = options.contentIdGuid || 'aabbccdd-1122-3344-5566-77889900aabb';
  const keyGuid = options.keyGuid || 'fedcba98-7654-3210-fedc-ba9876543210';
  const cik32 = options.cik32 || null;
  const encrypted = Boolean(cik32);
  const regionIdInXts = Boolean(options.regionIdInXts);
  const files: SyntheticSegmentFile[] = options.files || [
    {
      path: 'Files/SampleGame.exe',
      data: Buffer.from('MZ-SYNTHETIC-WIN32-GDK-BINARY-PAYLOAD', 'utf8'),
    },
  ];

  const segMetaBuf = buildSyntheticSegmentMetadata(files, vduidGuid);
  const udEntries: Array<{ name: string; data: Buffer }> = [
    { name: 'SegmentMetadata.bin', data: segMetaBuf },
  ];
  if (options.gameConfigXml) {
    udEntries.push({
      name: 'MicrosoftGame.config',
      data: Buffer.from(options.gameConfigXml, 'utf8'),
    });
  }
  if (options.appxManifestXml) {
    udEntries.push({
      name: 'AppxManifest.xml',
      data: Buffer.from(options.appxManifestXml, 'utf8'),
    });
  }

  const userDataBuf = buildSyntheticUserData(
    'Publisher.SampleGame_1.0.0.0_x64__8wekyb3d8bbwe',
    udEntries
  );
  const xvcDataLength =
    msixvcXvdParser.XVC_INFO_HEADER_SIZE + msixvcXvdParser.XVC_REGION_HEADER_SIZE;

  let totalDrivePages = 0;
  for (const f of files) {
    totalDrivePages += f.data.length === 0 ? 1 : msixvcXvdParser.bytesToPages(f.data.length);
  }
  const driveSize = Math.max(1, totalDrivePages) * msixvcXvdParser.XVD_PAGE_SIZE;

  const hdr = Buffer.alloc(msixvcXvdParser.XVD_HEADER_SECTION_SIZE, 0);
  hdr.write('msft-xvd', 0x200, 'ascii');
  let volFlags = encrypted
    ? msixvcXvdParser.XVD_VOLUME_FLAGS.READ_ONLY
    : msixvcXvdParser.XVD_VOLUME_FLAGS.READ_ONLY |
      msixvcXvdParser.XVD_VOLUME_FLAGS.ENCRYPTION_DISABLED;
  if (regionIdInXts) {
    volFlags |= msixvcXvdParser.XVD_VOLUME_FLAGS.REGION_ID_IN_XTS;
  }
  hdr.writeUInt32LE(volFlags, 0x208);
  hdr.writeUInt32LE(3, 0x20c); // formatVersion = 3
  hdr.writeBigUInt64LE(BigInt(driveSize), 0x218);
  msixvcXvdParser.writeGuidLE(vduidGuid, hdr, 0x220);
  hdr.writeUInt32LE(0, 0x280); // Fixed XVD
  hdr.writeUInt32LE(userDataBuf.length, 0x28c);
  hdr.writeUInt32LE(xvcDataLength, 0x290);
  msixvcXvdParser.writeGuidLE(contentIdGuid, hdr, 0x39c);
  msixvcXvdParser.writeGuidLE(vduidGuid, hdr, 0x3ac);

  const parsedHeader = msixvcXvdParser.parseXvdHeader(hdr);
  const layout = msixvcXvdParser.computeXvdLayout(parsedHeader);
  const container = Buffer.alloc(layout.totalContainerBytes, 0);

  hdr.copy(container, 0);
  userDataBuf.copy(container, layout.userData.byteOffset);

  const xvcBuf = Buffer.alloc(xvcDataLength, 0);
  msixvcXvdParser.writeGuidLE(contentIdGuid, xvcBuf, 0x000);
  xvcBuf.writeUInt32LE(1, 0xd10); // version
  xvcBuf.writeUInt32LE(1, 0xd14); // regionCount = 1
  if (encrypted) {
    xvcBuf.writeUInt16LE(1, 0xd1e); // keyCount = 1
    msixvcXvdParser.writeGuidLE(keyGuid, xvcBuf, 0x010);
  }
  const rOff = msixvcXvdParser.XVC_INFO_HEADER_SIZE;
  xvcBuf.writeUInt32LE(1, rOff + 0x00); // regionId = 1
  xvcBuf.writeUInt16LE(encrypted ? 0 : 0xffff, rOff + 0x04); // keyId
  xvcBuf.writeUInt32LE(0, rOff + 0x0c); // firstSegmentIndex = 0
  Buffer.from('PayloadRegion\0', 'utf16le').copy(xvcBuf, rOff + 0x10);
  xvcBuf.writeBigUInt64LE(BigInt(layout.driveData.byteOffset), rOff + 0x50);
  xvcBuf.writeBigUInt64LE(BigInt(driveSize), rOff + 0x58);
  xvcBuf.copy(container, layout.xvcInfo.byteOffset);

  const osslKey = encrypted && cik32 ? msixvcStreamExtractor.buildOpenSslXtsKey(cik32) : null;
  let pageCursorByteOffset = layout.driveData.byteOffset;
  let drivePageCounter = 0;

  for (const f of files) {
    const pages = f.data.length === 0 ? 1 : msixvcXvdParser.bytesToPages(f.data.length);
    for (let p = 0; p < pages; p += 1) {
      const plainPage = Buffer.alloc(msixvcXvdParser.XVD_PAGE_SIZE, 0);
      const sliceStart = p * msixvcXvdParser.XVD_PAGE_SIZE;
      if (sliceStart < f.data.length) {
        f.data.copy(
          plainPage,
          0,
          sliceStart,
          Math.min(f.data.length, sliceStart + msixvcXvdParser.XVD_PAGE_SIZE)
        );
      }

      // Non-sequential L0 data_unit to prove L0 hash tree lookup is actually honored
      const dataUnit = 1000 + drivePageCounter * 7;
      const hashedIdx = Math.floor(
        (pageCursorByteOffset - layout.userData.byteOffset) / msixvcXvdParser.XVD_PAGE_SIZE
      );
      const l0Page = Math.floor(hashedIdx / msixvcXvdParser.XVD_HASH_ENTRIES_PER_PAGE);
      const entryIdx = hashedIdx % msixvcXvdParser.XVD_HASH_ENTRIES_PER_PAGE;
      const entryByteOff =
        layout.hashTree.level0ByteOffset +
        l0Page * msixvcXvdParser.XVD_PAGE_SIZE +
        entryIdx * msixvcXvdParser.XVD_HASH_ENTRY_SIZE;
      container.writeUInt32LE(dataUnit, entryByteOff + 20);

      if (encrypted && osslKey) {
        const effectiveTweakRegionId = parsedHeader.regionIdInXts ? 1 : 0;
        const tweak = msixvcStreamExtractor.buildXvdXtsTweak(
          dataUnit,
          effectiveTweakRegionId,
          parsedHeader.vduidLow8
        );
        const cipherPage = msixvcStreamExtractor.encryptXvdPage(plainPage, osslKey, tweak);
        cipherPage.copy(container, pageCursorByteOffset);
      } else {
        plainPage.copy(container, pageCursorByteOffset);
      }

      pageCursorByteOffset += msixvcXvdParser.XVD_PAGE_SIZE;
      drivePageCounter += 1;
    }
  }

  return container;
}

export function buildDisplayCatalogGameFixture(overrides: {
  productId?: string;
  title?: string;
  productKind?: string;
  packageFormat?: string;
  platformName?: string;
  pfn?: string;
  xboxTitleId?: string;
  publisherName?: string;
  bundledSkus?: Array<{ BigId: string; SkuId?: string; IsPrimary?: boolean }>;
  includePackages?: boolean;
} = {}) {
  const productId = overrides.productId || '9NTESTGAME01';
  const title = overrides.title || 'Synthetic Horizon Adventure';
  const productKind = overrides.productKind || 'Game';
  const packageFormat = overrides.packageFormat ?? 'MSIXVC';
  const platformName = overrides.platformName ?? 'Windows.Desktop';
  const pfn = overrides.pfn ?? `Publisher.${productId}_8wekyb3d8bbwe`;
  const xboxTitleId = overrides.xboxTitleId ?? '19088743';
  const includePackages = overrides.includePackages !== false;

  return {
    ProductId: productId,
    ProductKind: productKind,
    LocalizedProperties: [
      {
        ProductTitle: title,
        DeveloperName: 'Synthetic Studio',
        PublisherName: overrides.publisherName || 'Microsoft Studios',
        ShortDescription: 'Synthetic test fixture description.',
        Images: [
          {
            ImagePurpose: 'Poster',
            Uri: '//store-images.s-microsoft.com/image/apps.1001.poster.png',
          },
          {
            ImagePurpose: 'SuperHeroArt',
            Uri: '//store-images.s-microsoft.com/image/apps.1001.hero.png',
          },
        ],
      },
    ],
    MarketProperties: [{ OriginalReleaseDate: '2025-05-10T00:00:00Z' }],
    Properties: {
      PackageFamilyName: pfn,
      XboxLiveGoldRequired: false,
      Categories: ['Action & adventure'],
    },
    AlternateIds: [{ IdType: 'XboxTitleId', Value: xboxTitleId }],
    DisplaySkuAvailabilities: [
      {
        Sku: {
          SkuId: '0010',
          Properties: {
            BundledSkus: overrides.bundledSkus || [],
            FulfillmentData: {
              PackageFamilyName: pfn,
              WuCategoryId: '11111111-2222-3333-4444-555555555555',
            },
            Packages: includePackages
              ? [
                  {
                    PackageId: 'pkg-001',
                    PackageFormat: packageFormat,
                    PackageFullName: 'Publisher.SampleGame_1.0.0.0_x64__8wekyb3d8bbwe',
                    PackageFamilyName: pfn,
                    ContentId: 'aabbccdd-1122-3344-5566-77889900aabb',
                    Architectures: ['x64'],
                    MaxDownloadSizeInBytes: 104857600,
                    PlatformDependencies: [{ PlatformName: platformName }],
                  },
                ]
              : [],
          },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Stateful React 19 Component Test Harness (Recursive Functional Expansion)
// ---------------------------------------------------------------------------

export function findElements(node: any, predicate: (el: any) => boolean, acc: any[] = []): any[] {
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

export function getTextContent(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (node && typeof node === 'object' && node.props) {
    return getTextContent(node.props.children);
  }
  return '';
}

export function expandFunctionVNodes(node: any): any {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expandFunctionVNodes);
  if (typeof node.type === 'function') {
    const rendered = node.type(node.props || {});
    return expandFunctionVNodes(rendered);
  }
  if (node.props && node.props.children !== undefined) {
    return {
      ...node,
      props: {
        ...node.props,
        children: expandFunctionVNodes(node.props.children),
      },
    };
  }
  return node;
}

export function createComponentHarness<P extends object>(Component: React.FC<P>, initialProps: P) {
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
    let idCounter = 0;
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
        idCounter += 1;
        return `mock-id-${idCounter}`;
      },
    };

    let tree: any;
    try {
      // Expand child functional components inside the mock dispatcher so child hooks execute cleanly
      tree = expandFunctionVNodes(Component(currentProps));
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

export async function flushMicrotasks(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

export function sendLoopbackRpc(
  port: number,
  frameObj: Record<string, unknown>
): Promise<{ closed: boolean; response?: any }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let settled = false;

    sock.on('connect', () => {
      sock.write(xboxRuntimeLoopbackServer.encodeRpcFrame(frameObj));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length >= 4 + len && !settled) {
          settled = true;
          const json = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
          sock.end();
          resolve({ closed: false, response: json });
        }
      }
    });

    sock.on('close', () => {
      if (!settled) {
        settled = true;
        resolve({ closed: true });
      }
    });

    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        // ECONNRESET / EPIPE expected when unauthorized socket is destroyed
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
          resolve({ closed: true });
        } else {
          reject(err);
        }
      }
    });
  });
}


export class Domain12TextNode {
  public readonly nodeType = 3;
  public parentNode: Domain12HTMLElement | Domain12DocumentFragment | null = null;
  constructor(public textContent: string) {}
}

export class Domain12DocumentFragment {
  public readonly nodeType = 11;
  public childNodes: Array<Domain12HTMLElement | Domain12TextNode> = [];

  get children(): Domain12HTMLElement[] {
    return this.childNodes.filter((n): n is Domain12HTMLElement => n instanceof Domain12HTMLElement);
  }

  appendChild(node: Domain12HTMLElement | Domain12TextNode): Domain12HTMLElement | Domain12TextNode {
    if (node.parentNode) {
      const idx = node.parentNode.childNodes.indexOf(node);
      if (idx >= 0) node.parentNode.childNodes.splice(idx, 1);
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  querySelectorAll(selector: string): Domain12HTMLElement[] {
    const out: Domain12HTMLElement[] = [];
    const visit = (nodes: Array<Domain12HTMLElement | Domain12TextNode>) => {
      for (const n of nodes) {
        if (n instanceof Domain12HTMLElement) {
          if (n.matchesSelector(selector)) out.push(n);
          visit(n.childNodes);
        }
      }
    };
    visit(this.childNodes);
    return out;
  }
}

export class Domain12HTMLElement {
  public readonly nodeType = 1;
  public readonly tagName: string;
  public parentNode: Domain12HTMLElement | Domain12DocumentFragment | null = null;
  public childNodes: Array<Domain12HTMLElement | Domain12TextNode> = [];
  public style: Record<string, string> = {};
  public dataset: Record<string, string> = {};
  public paused = true;
  public muted = false;
  public defaultMuted = false;
  public loop = false;
  public playsInline = false;
  public autoplay = false;
  public clientHeight = 480;
  public scrollTop = 0;
  public forbidInnerHtmlWrite = false;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return this.attrs.get('class') || '';
  }
  set className(val: string) {
    this.attrs.set('class', String(val));
  }

  get isConnected(): boolean {
    return true;
  }

  get children(): Domain12HTMLElement[] {
    return this.childNodes.filter((n): n is Domain12HTMLElement => n instanceof Domain12HTMLElement);
  }

  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  get innerHTML(): string {
    return this.childNodes
      .map((n) => (n instanceof Domain12TextNode ? n.textContent : n.outerHTML))
      .join('');
  }
  set innerHTML(_val: string) {
    if (this.forbidInnerHtmlWrite) {
      throw new Error('Forbidden innerHTML write on mounted container (mXSS violation)');
    }
  }

  get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const attrPairs = Array.from(this.attrs.entries())
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    const openTag = attrPairs ? `<${tag} ${attrPairs}>` : `<${tag}>`;
    return `${openTag}${this.innerHTML}</${tag}>`;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name.toLowerCase(), String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name.toLowerCase());
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name.toLowerCase());
  }

  addEventListener(type: string, cb: (...args: unknown[]) => void): void {
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(cb);
  }
  removeEventListener(type: string, cb: (...args: unknown[]) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  dispatchEvent(evt: { type: string }): boolean {
    const bucket = this.listeners.get(evt.type);
    if (bucket) {
      for (const cb of Array.from(bucket)) cb(evt);
    }
    return true;
  }

  pause(): void {
    this.paused = true;
  }
  load(): void {}
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  scrollIntoView(): void {}
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600 };
  }

  appendChild(node: Domain12HTMLElement | Domain12TextNode): Domain12HTMLElement | Domain12TextNode {
    if (node.parentNode) {
      const idx = node.parentNode.childNodes.indexOf(node);
      if (idx >= 0) node.parentNode.childNodes.splice(idx, 1);
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  replaceWith(...nodes: Array<Domain12HTMLElement | Domain12TextNode>): void {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const idx = parent.childNodes.indexOf(this);
    if (idx < 0) return;
    for (const n of nodes) {
      if (n.parentNode) {
        const oldIdx = n.parentNode.childNodes.indexOf(n);
        if (oldIdx >= 0) n.parentNode.childNodes.splice(oldIdx, 1);
      }
      n.parentNode = parent;
    }
    parent.childNodes.splice(idx, 1, ...nodes);
    this.parentNode = null;
  }

  remove(): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.childNodes.indexOf(this);
    if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
    this.parentNode = null;
  }

  replaceChildren(...nodes: Array<Domain12HTMLElement | Domain12TextNode | Domain12DocumentFragment>): void {
    for (const c of this.childNodes) {
      c.parentNode = null;
    }
    this.childNodes = [];
    for (const item of nodes) {
      if (item instanceof Domain12DocumentFragment) {
        const moved = [...item.childNodes];
        item.childNodes = [];
        for (const child of moved) {
          child.parentNode = this;
          this.childNodes.push(child);
        }
      } else {
        this.appendChild(item);
      }
    }
  }

  matchesSelector(selector: string): boolean {
    const clean = selector.trim();
    if (!clean) return false;
    if (clean.startsWith('.')) {
      const cls = clean.slice(1);
      return this.className.split(/\s+/).includes(cls);
    }
    return this.tagName.toLowerCase() === clean.toLowerCase();
  }

  closest(selector: string): Domain12HTMLElement | null {
    let cur: Domain12HTMLElement | Domain12DocumentFragment | null = this;
    while (cur && cur instanceof Domain12HTMLElement) {
      if (cur.matchesSelector(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelectorAll(selector: string): Domain12HTMLElement[] {
    const out: Domain12HTMLElement[] = [];
    const visit = (nodes: Array<Domain12HTMLElement | Domain12TextNode>) => {
      for (const n of nodes) {
        if (n instanceof Domain12HTMLElement) {
          if (n.matchesSelector(selector)) out.push(n);
          visit(n.childNodes);
        }
      }
    };
    visit(this.childNodes);
    return out;
  }
}

export function buildDomain12FragmentFromHtml(rawHtml: string): Domain12DocumentFragment {
  return buildSanitizedFragmentViaDomParser(rawHtml, {
    createFragment: () => new Domain12DocumentFragment(),
    createElement: (tagName) => new Domain12HTMLElement(tagName),
    createText: (text) => new Domain12TextNode(text),
    setAttribute: (el, name, value) => el.setAttribute(name, value),
    appendChildToElement: (parent, child) => {
      parent.appendChild(child);
    },
    appendChildToFragment: (frag, child) => {
      frag.appendChild(child);
    },
  });
}

export interface Domain12ComponentSlot {
  states: any[];
  refs: Array<{ current: any }>;
  prevDeps: Array<any[] | undefined>;
  cleanups: Array<(() => void) | undefined>;
}

export function createDomain12DeepRenderer<P extends object>(RootComponent: React.FC<P>, initialProps: P) {
  const slots = new Map<string, Domain12ComponentSlot>();
  const hostRefsByPath = new Map<string, Domain12HTMLElement>();
  const hostNodesByTestId = new Map<string, Domain12HTMLElement>();
  let currentProps = initialProps;
  let lastRenderedTree: any = null;

  const getOrCreateSlot = (slotKey: string): Domain12ComponentSlot => {
    let slot = slots.get(slotKey);
    if (!slot) {
      slot = { states: [], refs: [], prevDeps: [], cleanups: [] };
      slots.set(slotKey, slot);
    }
    return slot;
  };

  const renderNode = (
    node: any,
    pathPrefix: string,
    pendingEffects: Array<{ slot: Domain12ComponentSlot; idx: number; fn: () => any }>,
    visitedSlots: Set<string>
  ): any => {
    if (node === null || node === undefined || typeof node === 'boolean') return node;
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) {
      return node.map((child, idx) =>
        renderNode(child, `${pathPrefix}[${idx}]`, pendingEffects, visitedSlots)
      );
    }
    if (typeof node !== 'object') return node;

    if (node.$$typeof === Symbol.for('react.portal')) {
      return renderNode(node.children, `${pathPrefix}:portal`, pendingEffects, visitedSlots);
    }

    const rawType = node.type;
    if (rawType === React.Fragment) {
      return renderNode(node.props?.children, `${pathPrefix}:frag`, pendingEffects, visitedSlots);
    }

    let fnComponent: ((props: any, ref?: any) => any) | null = null;
    if (typeof rawType === 'function') {
      fnComponent = rawType;
    } else if (rawType && typeof rawType === 'object') {
      if (typeof rawType.type === 'function') fnComponent = rawType.type;
      else if (typeof rawType.render === 'function') fnComponent = rawType.render;
    }

    if (fnComponent) {
      const compName = (fnComponent as any).displayName || fnComponent.name || 'Anon';
      const keyPart = node.key !== null && node.key !== undefined ? `#${String(node.key)}` : '';
      const slotKey = `${pathPrefix}:${compName}${keyPart}`;
      visitedSlots.add(slotKey);
      const slot = getOrCreateSlot(slotKey);

      let stateIdx = 0;
      let refIdx = 0;
      let effectIdx = 0;
      const localEffects: Array<{ slot: Domain12ComponentSlot; idx: number; fn: () => any }> = [];

      const internals = (React as any)
        .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const prevH = internals.H;

      const scheduleEffect = (fn: () => any, deps?: any[]) => {
        const idx = effectIdx++;
        const oldDeps = slot.prevDeps[idx];
        const changed =
          !oldDeps ||
          !deps ||
          oldDeps.length !== deps.length ||
          deps.some((d, i) => !Object.is(d, oldDeps[i]));
        if (changed) {
          slot.prevDeps[idx] = deps;
          localEffects.push({ slot, idx, fn });
        }
      };

      internals.H = {
        useState(initial: any) {
          const idx = stateIdx++;
          if (idx >= slot.states.length) {
            slot.states.push(typeof initial === 'function' ? initial() : initial);
          }
          const setState = (updater: any) => {
            slot.states[idx] =
              typeof updater === 'function' ? updater(slot.states[idx]) : updater;
          };
          return [slot.states[idx], setState];
        },
        useRef(initial: any) {
          const idx = refIdx++;
          if (idx >= slot.refs.length) {
            slot.refs.push({ current: initial });
          }
          return slot.refs[idx];
        },
        useEffect: scheduleEffect,
        useLayoutEffect: scheduleEffect,
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
          return `id-${slotKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        },
      };

      let subTree: any;
      try {
        subTree = fnComponent(node.props || {}, node.props?.ref);
      } finally {
        internals.H = prevH;
      }

      const expandedChildren = renderNode(subTree, slotKey, pendingEffects, visitedSlots);
      pendingEffects.push(...localEffects);
      return expandedChildren;
    }

    if (typeof rawType === 'string') {
      const props = node.props || {};
      const testId = typeof props['data-testid'] === 'string' ? props['data-testid'] : undefined;
      const refProp = props.ref;
      if (refProp || testId) {
        let hostEl = hostRefsByPath.get(pathPrefix);
        if (!hostEl) {
          hostEl = new Domain12HTMLElement(rawType);
          if (testId === 'about-this-game-content') {
            hostEl.forbidInnerHtmlWrite = true;
          }
          hostRefsByPath.set(pathPrefix, hostEl);
        }
        if (testId) {
          hostEl.setAttribute('data-testid', testId);
          hostNodesByTestId.set(testId, hostEl);
        }
        if (typeof props.className === 'string') {
          hostEl.className = props.className;
        }
        if (typeof refProp === 'function') {
          refProp(hostEl);
        } else if (refProp && typeof refProp === 'object' && 'current' in refProp) {
          refProp.current = hostEl;
        }
      }

      const nextChildren =
        props.children !== undefined
          ? renderNode(props.children, `${pathPrefix}/${rawType}`, pendingEffects, visitedSlots)
          : props.children;

      return {
        ...node,
        type: rawType,
        props: {
          ...props,
          children: nextChildren,
        },
      };
    }

    return node;
  };

  const render = (nextProps?: Partial<P>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    const pendingEffects: Array<{ slot: Domain12ComponentSlot; idx: number; fn: () => any }> = [];
    const visitedSlots = new Set<string>();

    const rootElement = React.createElement(RootComponent, currentProps);
    lastRenderedTree = renderNode(rootElement, 'root', pendingEffects, visitedSlots);

    for (const [key, slot] of Array.from(slots.entries())) {
      if (!visitedSlots.has(key)) {
        for (const cleanup of slot.cleanups) {
          if (typeof cleanup === 'function') cleanup();
        }
        slots.delete(key);
      }
    }

    for (const eff of pendingEffects) {
      const prevCleanup = eff.slot.cleanups[eff.idx];
      if (typeof prevCleanup === 'function') {
        prevCleanup();
      }
      const nextCleanup = eff.fn();
      eff.slot.cleanups[eff.idx] = typeof nextCleanup === 'function' ? nextCleanup : undefined;
    }

    return lastRenderedTree;
  };

  const unmount = () => {
    for (const slot of slots.values()) {
      for (const cleanup of slot.cleanups) {
        if (typeof cleanup === 'function') cleanup();
      }
    }
    slots.clear();
  };

  const getHostElementByTestId = (testId: string): Domain12HTMLElement | undefined =>
    hostNodesByTestId.get(testId);

  return { render, unmount, getHostElementByTestId };
}

export function buildValidJpegBuffer(totalBytes = 128, fillByte = 0x5a): Buffer {
  const buf = Buffer.alloc(Math.max(64, totalBytes), fillByte);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xd9;
  return buf;
}

export function buildSyntheticAnimatedGif89aBuffer(options: { frameCount: number; frame1PayloadBytes: number }): Buffer {
  const chunks: Buffer[] = [];
  // GIF89a header + Logical Screen Descriptor (1x1, 2-color GCT) + 6-byte GCT
  chunks.push(
    Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
      0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // LSD (GCT flag = 1, size = 2)
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // 2-entry GCT
    ])
  );

  // Netscape 2.0 loop extension
  chunks.push(
    Buffer.from([
      0x21, 0xff, 0x0b,
      0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
      0x03, 0x01, 0x00, 0x00, 0x00,
    ])
  );

  for (let f = 0; f < options.frameCount; f += 1) {
    // Graphic Control Extension
    chunks.push(Buffer.from([0x21, 0xf9, 0x04, 0x04, 0x08, 0x00, 0x00, 0x00]));
    // Image Descriptor (0,0 1x1, no LCT) + LZW minimum code size = 2
    chunks.push(Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02]));

    let remaining = f === 0 ? Math.max(4, options.frame1PayloadBytes) : 4;
    while (remaining > 0) {
      const subLen = Math.min(255, remaining);
      const subBlock = Buffer.alloc(1 + subLen, (0x31 + f) & 0xff);
      subBlock[0] = subLen;
      chunks.push(subBlock);
      remaining -= subLen;
    }
    chunks.push(Buffer.from([0x00])); // Image data block terminator
  }

  chunks.push(Buffer.from([0x3b])); // GIF trailer
  return Buffer.concat(chunks);
}

export function makeMockFetchBinaryResponse(opts: {
  status: number;
  body: Buffer | string;
  contentType?: string;
}): Response {
  const buf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
  const ct = opts.contentType || (Buffer.isBuffer(opts.body) ? 'image/jpeg' : 'application/json');
  const headersMap = new Map<string, string>([
    ['content-type', ct],
    ['content-length', String(buf.length)],
  ]);
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    statusText: opts.status >= 200 && opts.status < 300 ? 'OK' : 'Error',
    headers: {
      get: (k: string) => headersMap.get(k.toLowerCase()) ?? null,
    },
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as Response;
}
