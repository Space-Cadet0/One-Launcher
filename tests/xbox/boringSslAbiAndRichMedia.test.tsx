import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import axios from 'axios';

import {
  saveIntegrations,
  saveXboxProfileState,
  loadXboxProfileState,
  mergeStorefrontGames,
  mergeUpdatedGamePreservingLivePlatformState,
  loadCurrentCatalog,
  compactGameForStorage,
  reconcileCatalogGamesWithInstalledRecords,
} from '../../src/services/integrations/integrationStorage';
import { sanitizeGameCatalog } from '../../src/services/integrations/catalogSanitizer';
import {
  stripStorefrontPlatformDisambiguators,
  stripYearEditionPhrases,
  normalizeTitleKey,
  splitCamelCaseTitle,
  alignCompoundWordTokens,
  extractSequelIdentifier,
  isSequelMismatch,
  sanitizeStoreReleaseDate,
} from '../../src/services/common/titleUtils';
import {
  computeEntityMatchConfidence,
  parseReleaseYear,
} from '../../src/services/common/entityResolver';
import {
  SteamMatcherService,
  computeTitleSimilarity,
} from '../../src/services/steam/steamMatcher';
import {
  SteamApiService,
  steamApi,
  truncateHtmlSafely,
} from '../../src/services/steam/steamApi';
import { steamAchievementsService } from '../../src/services/steam/steamAchievementsService';
import { fallbackMetadataProvider } from '../../src/services/steam/fallbackMetadataProvider';
import { requestScheduler } from '../../src/services/network/requestScheduler';
import { onlineLifecycleManager } from '../../src/services/network/onlineLifecycleManager';
import {
  pickBestEnrichedMetadata,
  pickPreferredCapsuleImage,
  pickPreferredDetailedDescription,
} from '../../src/services/storage/librarySync';
import * as indexedDbVault from '../../src/services/storage/indexedDbVault';
import { getStorefrontNativeOsFlags } from '../../src/services/platform/nativeOsService';
import { reconcileCatalogTrophiesRecords } from '../../src/utils/catalogMergeUtils';
import { resolveEffectiveLaunchPolicy as resolveTsLaunchPolicy } from '../../src/contracts/launchPolicyResolver';
import { LauncherService, launcherService } from '../../src/services/launcher/launcherService';
import { achievementDetailService } from '../../src/services/achievements/achievementDetailService';
import { StorefrontIcon } from '../../src/components/Common/StorefrontIcon';
import { DownloadManagerDrawer } from '../../src/components/Launcher/DownloadManagerDrawer';
import { IntegrationsModal } from '../../src/components/Navigation/IntegrationsModal';
import { GameAchievementsModal } from '../../src/components/Achievements/GameAchievementsModal';
import { GameInstallModal } from '../../src/components/Launcher/GameInstallModal';
import { LibraryGridView } from '../../src/components/Library/LibraryGridView';
import { LibrarySidebar } from '../../src/components/Library/LibrarySidebar';
import { PlatformBadges } from '../../src/components/SteamStoreDetail/PlatformBadges';
import { SteamLibraryActionBar } from '../../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { SteamStorePage } from '../../src/components/SteamStoreDetail/SteamStorePage';
import { buildLibraryFilterIndex } from '../../src/services/filter/libraryFilterIndex';
import { criticScoreService } from '../../src/services/critic/criticScoreService';
import {
  saveStagedCache,
  loadStagedCache,
  STAGED_CACHE_VERSION,
} from '../../src/services/storage/stagedCacheService';
import type { CanonicalGame } from '../../src/contracts/game';
import type { StorefrontIntegration } from '../../src/contracts/integration';
import type { SteamEnrichedMetadata } from '../../src/contracts/steam';

import {
  nodeRequire,
  xboxAuthManager,
  xboxBoringSslCrypto,
  xboxDeviceClep,
  xboxCatalogAndGamePass,
  xboxAchievementsAndStats,
  msixvcXvdParser,
  msixvcStreamExtractor,
  xboxRuntimeLoopbackServer,
  xboxTitleStorageSync,
  tokenVault,
  binaryAndManifestInspectors,
  cjsLaunchPolicyResolver,
  uninstallSafety,
  cloudSaveEngine,
  wineAndCrossOverManager,
  offlineVaultMod,
  federatorMod,
  launcherEngine,
  buildXboxBridge,
  setDomPurifyFragmentBuilder,
  getDomPurifyFragmentBuilder,
  sanitizeHtmlStringViaDomParser,
  createMemoryStorage,
  makeCanonicalGameFixture,
  buildValidMinimalPe64Buffer,
  buildSyntheticSpLicenseBlockBase64,
  buildSyntheticSegmentMetadata,
  buildSyntheticUserData,
  buildSyntheticMsixvcImage,
  buildDisplayCatalogGameFixture,
  findElements,
  getTextContent,
  expandFunctionVNodes,
  createComponentHarness,
  flushMicrotasks,
  sendLoopbackRpc,
  Domain12TextNode,
  Domain12DocumentFragment,
  Domain12HTMLElement,
  buildDomain12FragmentFromHtml,
  createDomain12DeepRenderer,
  buildValidJpegBuffer,
  buildSyntheticAnimatedGif89aBuffer,
  makeMockFetchBinaryResponse,
  type SyntheticSegmentFile,
  type SyntheticMsixvcOptions,
} from '../helpers/xboxTestHarness';

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

// 11. Wave 2A–2C BoringSSL Crypto Parity, Real Electron Runtime Gate,
//     XGR / GameInput ABI & Merged Cross-Storefront Card Immediate Play
// ===========================================================================

describe('11. Wave 2A–2C BoringSSL Crypto Parity, Real Electron Runtime Gate, XGR/GameInput ABI & Merged Card Immediate Play', () => {
  let tmpDir: string;
  let prevWindow: any;
  let prevLocalStorage: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-w2abc-'));
    prevWindow = (globalThis as any).window;
    prevLocalStorage = (globalThis as any).localStorage;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
    if (prevLocalStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      (globalThis as any).localStorage = prevLocalStorage;
    }
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates xboxBoringSslCrypto against RFC 3394 vectors, IEEE P1619 Annex B vectors (including Key1 === Key2), odd Buffer.subarray offsets, key-mutation invalidation, and tamper rejection', () => {
    // 1. Official RFC 3394 Section 4.1, 4.2, 4.3, and 4.6 test vectors (128, 192, and 256-bit KEKs)
    const rfc3394Vectors = [
      {
        name: 'RFC 3394 4.1 (128-bit KEK, 128-bit Key)',
        kekHex: '000102030405060708090a0b0c0d0e0f',
        keyHex: '00112233445566778899aabbccddeeff',
        cipherHex: '1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5',
      },
      {
        name: 'RFC 3394 4.2 (192-bit KEK, 128-bit Key)',
        kekHex: '000102030405060708090a0b0c0d0e0f1011121314151617',
        keyHex: '00112233445566778899aabbccddeeff',
        cipherHex: '96778b25ae6ca435f92b5b97c050aed2468ab8a17ad84e5d',
      },
      {
        name: 'RFC 3394 4.3 (256-bit KEK, 128-bit Key)',
        kekHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
        keyHex: '00112233445566778899aabbccddeeff',
        cipherHex: '64e8c3f9ce0f5ba263e9777905818a2a93c8191e7d6e8ae7',
      },
      {
        name: 'RFC 3394 4.6 (256-bit KEK, 256-bit Key)',
        kekHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
        keyHex: '00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f',
        cipherHex:
          '28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21',
      },
    ];

    for (const vec of rfc3394Vectors) {
      const kek = Buffer.from(vec.kekHex, 'hex');
      const plainKey = Buffer.from(vec.keyHex, 'hex');
      const wrapped = xboxBoringSslCrypto.aesKeyWrapRfc3394(plainKey, kek);
      expect(wrapped.toString('hex')).toBe(vec.cipherHex);
      const unwrapped = xboxBoringSslCrypto.aesKeyUnwrapRfc3394(wrapped, kek);
      expect(unwrapped.equals(plainKey)).toBe(true);
    }

    // 2. CIK wrap/unwrap across odd subarray offsets, hex, and Base64 + constant-time tamper rejection
    const rawCik32 = crypto.randomBytes(32);
    const devKey16 = crypto.randomBytes(16);
    const unalignedPool = Buffer.alloc(128, 0xee);
    rawCik32.copy(unalignedPool, 3); // byteOffset % 4 === 3
    devKey16.copy(unalignedPool, 41); // byteOffset % 4 === 1

    const wrappedCik40 = xboxBoringSslCrypto.aesKeyWrapRfc3394(
      unalignedPool.subarray(3, 35),
      unalignedPool.subarray(41, 57)
    );
    expect(wrappedCik40.length).toBe(40);
    expect(
      xboxBoringSslCrypto.unwrapCikWithDeviceKey(wrappedCik40.toString('hex'), devKey16.toString('hex'))
    ).toEqual(rawCik32);
    expect(
      xboxBoringSslCrypto.unwrapCikWithDeviceKey(
        wrappedCik40.toString('base64'),
        devKey16.toString('base64')
      )
    ).toEqual(rawCik32);

    // Tamper 1 bit in integrity register (byte 0) and 1 bit in payload body (byte 39)
    for (const tamperIdx of [0, 20, 39]) {
      const tampered = Buffer.from(wrappedCik40);
      tampered[tamperIdx] ^= 0x01;
      expect(() => xboxBoringSslCrypto.aesKeyUnwrapRfc3394(tampered, devKey16)).toThrow(
        /integrity check failed/i
      );
    }

    // 3. IEEE P1619-2007 Annex B Vector 1 (Key1 === Key2 === 00..00) & Vector 2 (Key1 !== Key2)
    const p1619Vec1Cipher = xboxBoringSslCrypto.transformXtsSectorEcb(
      Buffer.alloc(32, 0x00),
      Buffer.alloc(32, 0x00),
      Buffer.alloc(16, 0x00),
      true
    );
    expect(p1619Vec1Cipher.toString('hex')).toBe(
      '917cf69ebd68b2ec9b9fe9a3eadda692cd43d2f59598ed858c02c2652fbf922e'
    );
    expect(
      xboxBoringSslCrypto.transformXtsSectorEcb(
        p1619Vec1Cipher,
        Buffer.alloc(32, 0x00),
        Buffer.alloc(16, 0x00),
        false
      )
    ).toEqual(Buffer.alloc(32, 0x00));

    const p1619Key2 = Buffer.concat([Buffer.alloc(16, 0x11), Buffer.alloc(16, 0x22)]);
    const p1619Tweak2 = Buffer.from('33333333330000000000000000000000', 'hex');
    const p1619Plain2 = Buffer.alloc(32, 0x44);
    const p1619Vec2Cipher = xboxBoringSslCrypto.transformXtsSectorEcb(
      p1619Plain2,
      p1619Key2,
      p1619Tweak2,
      true
    );
    expect(p1619Vec2Cipher.toString('hex')).toBe(
      'c454185e6a16936e39334038acef838bfb186fff7480adc4289382ecd6d394f0'
    );
    expect(
      xboxBoringSslCrypto.transformXtsSectorEcb(p1619Vec2Cipher, p1619Key2, p1619Tweak2, false)
    ).toEqual(p1619Plain2);

    // 4. Multi-page decryptContiguousPageBuffer on odd Buffer.subarray offsets (1, 2, 3) + key-mutation safety
    const pageCount = 6;
    const totalBytes = pageCount * xboxBoringSslCrypto.XVD_PAGE_SIZE;
    const plainMulti = crypto.randomBytes(totalBytes);
    const mutableOsslKey = xboxBoringSslCrypto.buildOpenSslXtsKey(rawCik32);
    const vduidLow8 = crypto.randomBytes(8);
    const dataUnits = new Uint32Array([101, 208, 315, 422, 529, 636]);
    const regionId = 0;

    const cipherPages: Buffer[] = [];
    for (let p = 0; p < pageCount; p += 1) {
      const pageSlice = plainMulti.subarray(p * 0x1000, (p + 1) * 0x1000);
      const tw = xboxBoringSslCrypto.buildXvdXtsTweak(dataUnits[p], regionId, vduidLow8);
      // Cross-verify encryptXvdPage against Node's OpenSSL aes-128-xts reference
      const osslRef = crypto.createCipheriv('aes-128-xts', mutableOsslKey, tw);
      const refCipherPage = Buffer.concat([osslRef.update(pageSlice), osslRef.final()]);
      const bsslCipherPage = xboxBoringSslCrypto.encryptXvdPage(pageSlice, mutableOsslKey, tw);
      expect(bsslCipherPage.equals(refCipherPage)).toBe(true);
      cipherPages.push(bsslCipherPage);
    }
    const cipherContiguous = Buffer.concat(cipherPages);

    for (const oddOffset of [1, 2, 3]) {
      const backing = Buffer.alloc(oddOffset + totalBytes + 32, 0xaa);
      cipherContiguous.copy(backing, oddOffset);
      const unalignedCipherView = backing.subarray(oddOffset, oddOffset + totalBytes);
      expect(unalignedCipherView.byteOffset % 4).not.toBe(0);

      const vduidBacking = Buffer.alloc(oddOffset + 16, 0xbb);
      vduidLow8.copy(vduidBacking, oddOffset);
      const unalignedVduid = vduidBacking.subarray(oddOffset, oddOffset + 8);

      const decrypted = xboxBoringSslCrypto.decryptContiguousPageBuffer({
        rawBuffer: unalignedCipherView,
        pageCount,
        dataUnits,
        osslXtsKey: mutableOsslKey,
        regionId,
        vduidLow8: unalignedVduid,
      });
      expect(decrypted.equals(plainMulti)).toBe(true);
    }

    // Mutate `mutableOsslKey` in place and verify WeakMap cache invalidates stale ECB contexts
    mutableOsslKey[0] ^= 0xff;
    const wrongKeyDecrypted = xboxBoringSslCrypto.decryptXvdPage(
      cipherPages[0],
      mutableOsslKey,
      xboxBoringSslCrypto.buildXvdXtsTweak(dataUnits[0], regionId, vduidLow8)
    );
    expect(wrongKeyDecrypted.equals(plainMulti.subarray(0, 0x1000))).toBe(false);
  });

  it('executes unwrapContentCik, inspectMsixvcContainer, and worker_threads extractMsixvcInWorker inside real Electron BoringSSL (process.versions.openssl === "0.0.0")', () => {
    const electronBinaryPath = nodeRequire('electron') as string;
    expect(typeof electronBinaryPath).toBe('string');
    expect(fs.existsSync(electronBinaryPath)).toBe(true);

    const cik32 = crypto.randomBytes(32);
    const deviceKey16 = crypto.randomBytes(16);
    const keyGuid = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';
    const contentIdGuid = '12345678-9abc-4def-8012-3456789abcde';

    const peExePayload = Buffer.concat([buildValidMinimalPe64Buffer(), crypto.randomBytes(5000)]);
    const multiPageAsset = crypto.randomBytes(3 * 0x1000 + 777);
    const gameConfigXml = `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="BoringSslGate.SynthTitle" Publisher="CN=11223344-5566-7788-99AA-BBCCDDEEFF00" Version="2.1.0.0" />
  <TitleId>6432DF20</TitleId>
  <MSAAppId>0000000048193752</MSAAppId>
  <DesktopRegistration>
    <ExecutableList>
      <Executable Name="BoringSslGame_x64.exe" Id="Game" />
    </ExecutableList>
  </DesktopRegistration>
</Game>`;

    // Build a multi-region `.msixvc` image (`0x40000003` unencrypted prefix + `0x3E9` encrypted payload)
    // and omit `gameConfigXml` from plaintext `userData` so `inspectMsixvcContainer({ msixvcPath, cik })`
    // ALSO decrypts `Files/MicrosoftGame.config` out of encrypted `0x3E9` under Electron BoringSSL!
    const vduidGuid = '99887766-5544-4321-89ab-cdef01234567';
    const unencCfgBytes = Buffer.from('unbindall\nbind ENTER "+attack"\n', 'utf8');
    const segFiles: SyntheticSegmentFile[] = [
      // Region 0x40000003 (unencrypted prefix: segment 0)
      { path: 'Files/Config/default.cfg', data: unencCfgBytes },
      // Region 0x3E9 (AES-128-XTS encrypted payload: segments 1..3)
      { path: 'Files/MicrosoftGame.config', data: Buffer.from(gameConfigXml, 'utf8') },
      { path: 'Files/BoringSslGame_x64.exe', data: peExePayload },
      { path: 'Files/Data/pak0.bin', data: multiPageAsset },
    ];
    const segMetaBuf = buildSyntheticSegmentMetadata(segFiles, vduidGuid);
    const userDataBuf = buildSyntheticUserData(
      'BoringSslGate.SynthTitle_2.1.0.0_x64__8wekyb3d8bbwe',
      [{ name: 'SegmentMetadata.bin', data: segMetaBuf }]
    );
    const xvcDataLength =
      msixvcXvdParser.XVC_INFO_HEADER_SIZE + 2 * msixvcXvdParser.XVC_REGION_HEADER_SIZE;
    const prefixPages = msixvcXvdParser.bytesToPages(unencCfgBytes.length);
    const payloadPages = segFiles
      .slice(1)
      .reduce((acc, f) => acc + msixvcXvdParser.bytesToPages(f.data.length), 0);
    const driveSize = (prefixPages + payloadPages) * msixvcXvdParser.XVD_PAGE_SIZE;

    const hdr = Buffer.alloc(msixvcXvdParser.XVD_HEADER_SECTION_SIZE, 0);
    hdr.write('msft-xvd', 0x200, 'ascii');
    hdr.writeUInt32LE(msixvcXvdParser.XVD_VOLUME_FLAGS.READ_ONLY, 0x208); // regionIdInXts = false
    hdr.writeUInt32LE(3, 0x20c);
    hdr.writeBigUInt64LE(BigInt(driveSize), 0x218);
    msixvcXvdParser.writeGuidLE(vduidGuid, hdr, 0x220);
    hdr.writeUInt32LE(0, 0x280);
    hdr.writeUInt32LE(userDataBuf.length, 0x28c);
    hdr.writeUInt32LE(xvcDataLength, 0x290);
    msixvcXvdParser.writeGuidLE(contentIdGuid, hdr, 0x39c);
    msixvcXvdParser.writeGuidLE(vduidGuid, hdr, 0x3ac);

    const parsedHdr = msixvcXvdParser.parseXvdHeader(hdr);
    const layout = msixvcXvdParser.computeXvdLayout(parsedHdr);
    const msixvcBuf = Buffer.alloc(layout.totalContainerBytes, 0);
    hdr.copy(msixvcBuf, 0);
    userDataBuf.copy(msixvcBuf, layout.userData.byteOffset);

    const xvcBuf = Buffer.alloc(xvcDataLength, 0);
    msixvcXvdParser.writeGuidLE(contentIdGuid, xvcBuf, 0x000);
    msixvcXvdParser.writeGuidLE(keyGuid, xvcBuf, 0x010);
    xvcBuf.writeUInt32LE(1, 0xd10);
    xvcBuf.writeUInt32LE(2, 0xd14); // 2 regions: 0x40000003 + 0x3E9
    xvcBuf.writeUInt16LE(1, 0xd1e); // keyCount = 1

    const prefixOff = layout.driveData.byteOffset;
    const prefixLen = prefixPages * msixvcXvdParser.XVD_PAGE_SIZE;
    const payloadOff = prefixOff + prefixLen;
    const payloadLen = payloadPages * msixvcXvdParser.XVD_PAGE_SIZE;

    const r0 = msixvcXvdParser.XVC_INFO_HEADER_SIZE;
    xvcBuf.writeUInt32LE(0x40000003, r0 + 0x00);
    xvcBuf.writeUInt16LE(0xffff, r0 + 0x04);
    xvcBuf.writeUInt32LE(0, r0 + 0x0c);
    Buffer.from('PrefixUnenc\0', 'utf16le').copy(xvcBuf, r0 + 0x10);
    xvcBuf.writeBigUInt64LE(BigInt(prefixOff), r0 + 0x50);
    xvcBuf.writeBigUInt64LE(BigInt(prefixLen), r0 + 0x58);

    const r1 = r0 + msixvcXvdParser.XVC_REGION_HEADER_SIZE;
    xvcBuf.writeUInt32LE(0x3e9, r1 + 0x00);
    xvcBuf.writeUInt16LE(0, r1 + 0x04);
    xvcBuf.writeUInt32LE(1, r1 + 0x0c);
    Buffer.from('PayloadEnc\0', 'utf16le').copy(xvcBuf, r1 + 0x10);
    xvcBuf.writeBigUInt64LE(BigInt(payloadOff), r1 + 0x50);
    xvcBuf.writeBigUInt64LE(BigInt(payloadLen), r1 + 0x58);
    xvcBuf.copy(msixvcBuf, layout.xvcInfo.byteOffset);

    const osslKey = xboxBoringSslCrypto.buildOpenSslXtsKey(cik32);
    let diskCursor = prefixOff;
    let pageCounter = 0;
    for (let sIdx = 0; sIdx < segFiles.length; sIdx += 1) {
      const sf = segFiles[sIdx];
      const pages = msixvcXvdParser.bytesToPages(sf.data.length);
      const isEnc = sIdx >= 1;
      for (let p = 0; p < pages; p += 1) {
        const plainPage = Buffer.alloc(msixvcXvdParser.XVD_PAGE_SIZE, 0);
        const start = p * msixvcXvdParser.XVD_PAGE_SIZE;
        sf.data.copy(
          plainPage,
          0,
          start,
          Math.min(sf.data.length, start + msixvcXvdParser.XVD_PAGE_SIZE)
        );
        const dataUnit = 500 + pageCounter * 11;
        const hashedIdx = Math.floor(
          (diskCursor - layout.userData.byteOffset) / msixvcXvdParser.XVD_PAGE_SIZE
        );
        const l0Page = Math.floor(hashedIdx / msixvcXvdParser.XVD_HASH_ENTRIES_PER_PAGE);
        const entryIdx = hashedIdx % msixvcXvdParser.XVD_HASH_ENTRIES_PER_PAGE;
        const entryOff =
          layout.hashTree.level0ByteOffset +
          l0Page * msixvcXvdParser.XVD_PAGE_SIZE +
          entryIdx * msixvcXvdParser.XVD_HASH_ENTRY_SIZE;
        msixvcBuf.writeUInt32LE(dataUnit, entryOff + 20);
        if (isEnc) {
          const tw = xboxBoringSslCrypto.buildXvdXtsTweak(dataUnit, 0, parsedHdr.vduidLow8);
          xboxBoringSslCrypto.encryptXvdPage(plainPage, osslKey, tw).copy(msixvcBuf, diskCursor);
        } else {
          plainPage.copy(msixvcBuf, diskCursor);
        }
        diskCursor += msixvcXvdParser.XVD_PAGE_SIZE;
        pageCounter += 1;
      }
    }

    const msixvcPath = path.join(tmpDir, 'boringssl-encrypted.msixvc');
    const extractOutDir = path.join(tmpDir, 'boringssl-extracted');
    const gateScriptPath = path.join(tmpDir, 'run-under-electron-boringssl.cjs');
    fs.writeFileSync(msixvcPath, msixvcBuf);

    const repoRoot = path.resolve(__dirname, '../..');
    fs.writeFileSync(
      gateScriptPath,
      `'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [repoRoot, msixvcPath, extractOutDir, cikHex, devKeyHex] = process.argv.slice(2);
const xboxDeviceClep = require(path.join(repoRoot, 'electron/storefronts/xbox/xboxDeviceClep.cjs'));
const msixvcXvdParser = require(path.join(repoRoot, 'electron/storefronts/xbox/msixvcXvdParser.cjs'));
const msixvcStreamExtractor = require(path.join(repoRoot, 'electron/storefronts/xbox/msixvcStreamExtractor.cjs'));

(async () => {
  const ciphers = crypto.getCiphers();
  const cikBuf = Buffer.from(cikHex, 'hex');
  const devKeyBuf = Buffer.from(devKeyHex, 'hex');

  const wrapped40 = xboxDeviceClep.wrapContentCik(cikBuf, devKeyBuf);
  const unwrapped32 = xboxDeviceClep.unwrapContentCik(wrapped40, devKeyBuf);

  const inspected = await msixvcXvdParser.inspectMsixvcContainer({ msixvcPath, cik: unwrapped32 });
  const compat = await msixvcXvdParser.probeMsixvcCompatibility({ msixvcPath, cik: unwrapped32 });
  const extracted = await msixvcStreamExtractor.extractMsixvcInWorker({
    msixvcPath,
    installDir: extractOutDir,
    cik: unwrapped32,
  });

  const sha256File = (rel) =>
    crypto.createHash('sha256').update(fs.readFileSync(path.join(extractOutDir, rel))).digest('hex');

  process.stdout.write(JSON.stringify({
    ok: true,
    openssl: process.versions.openssl,
    electron: process.versions.electron,
    hasAesXtsCipher: ciphers.includes('aes-128-xts'),
    hasAesWrapCipher: ciphers.includes('id-aes128-wrap'),
    unwrappedMatches: unwrapped32.equals(cikBuf),
    isEncrypted: !inspected.header?.encryptionDisabled && inspected.mappedSegments.some((s) => s.isEncrypted),
    inspectedTitleId: inspected.gameConfig?.titleId || null,
    compatibilityTier: compat.tier || null,
    extractedFilesCount: extracted.fileCount,
    cfgSha256: sha256File('Config/default.cfg'),
    exeSha256: sha256File('BoringSslGame_x64.exe'),
    pakSha256: sha256File('Data/pak0.bin'),
  }) + '\\n');
})().catch((err) => {
  process.stderr.write((err && err.stack ? err.stack : String(err)) + '\\n');
  process.exit(1);
});
`,
      'utf8'
    );

    const stdout = execFileSync(
      electronBinaryPath,
      [
        gateScriptPath,
        repoRoot,
        msixvcPath,
        extractOutDir,
        cik32.toString('hex'),
        deviceKey16.toString('hex'),
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          HOME: tmpDir,
          TMPDIR: tmpDir,
        },
      }
    );

    const lastJsonLine = stdout
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('{'))
      .pop();
    expect(lastJsonLine).toBeTruthy();
    const gateRes = JSON.parse(lastJsonLine!);

    expect(gateRes.ok).toBe(true);
    expect(gateRes.openssl).toBe('0.0.0');
    expect(Boolean(gateRes.electron)).toBe(true);
    expect(gateRes.hasAesXtsCipher).toBe(false);
    expect(gateRes.hasAesWrapCipher).toBe(false);
    expect(gateRes.unwrappedMatches).toBe(true);
    expect(gateRes.isEncrypted).toBe(true);
    expect(gateRes.inspectedTitleId).toBe('6432DF20');
    expect(gateRes.compatibilityTier).toBe('tier_a_supported');
    expect(gateRes.extractedFilesCount).toBe(4);
    expect(gateRes.cfgSha256).toBe(crypto.createHash('sha256').update(unencCfgBytes).digest('hex'));
    expect(gateRes.exeSha256).toBe(crypto.createHash('sha256').update(peExePayload).digest('hex'));
    expect(gateRes.pakSha256).toBe(
      crypto.createHash('sha256').update(multiPageAsset).digest('hex')
    );
  });

  it('verifies rebuilt bridge DLLs (--verify-only) and enforces XSystemGetXboxLiveSandboxId(..., NULL), XUserGetGamertag(..., NULL), receipt PFN fallback, and GameInput focus/active-device ABI contracts', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const verifyOut = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/build-xbox-bridge.cjs'), '--verify-only'],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, HOME: tmpDir, TMPDIR: tmpDir },
      }
    );
    const verified = JSON.parse(verifyOut);
    expect(verified.ok).toBe(true);
    expect(verified.machine).toBe('0x8664');
    expect(verified.marker).toBe('OneLauncher.XGRBridge.v1');
    expect(verified.gameInputBridge?.machine).toBe('0x8664');
    expect(verified.gameInputBridge?.marker).toBe('OneLauncher.GameInputBridge.v1');
    expect(verified.gameInputBridge?.exports).toEqual(['DllCanUnloadNow', 'GameInputCreate']);

    // Verify compiled PE32+ binary contents match rebuilt C11 Wave 2B-1 features
    const xgrDllBytes = fs.readFileSync(
      path.join(repoRoot, 'electron/helpers/bin/one_xgameruntime_bridge.dll')
    );
    expect(xgrDllBytes.includes(Buffer.from('RETAIL\0', 'ascii'))).toBe(true);
    expect(
      xgrDllBytes.includes(Buffer.from('.onelauncher-xbox-receipt.json', 'utf16le'))
    ).toBe(true);
    expect(
      xgrDllBytes.includes(Buffer.from('.onelauncher-xbox-install.json', 'utf16le'))
    ).toBe(true);
    expect(xgrDllBytes.includes(Buffer.from('packageFamilyName\0', 'ascii'))).toBe(true);

    const giDllBytes = fs.readFileSync(
      path.join(repoRoot, 'electron/helpers/bin/one_gameinput_bridge.dll')
    );
    expect(giDllBytes.includes(Buffer.from('GetAsyncKeyState', 'ascii'))).toBe(true);
    expect(giDllBytes.includes(Buffer.from('MapVirtualKeyW', 'ascii'))).toBe(true);
    expect(giDllBytes.includes(Buffer.from('GetForegroundWindow', 'ascii'))).toBe(true);

    // Verify C11 ABI contracts for `_Out_opt_ SIZE_T *used` (`NULL` allowed without E_POINTER!)
    const xsysSrc = fs.readFileSync(
      path.join(repoRoot, 'electron/helpers/xgr_bridge/xsystem_misc.c'),
      'utf8'
    );
    const sandboxFnMatch = xsysSrc.match(
      /xsys_GetXboxLiveSandboxId\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/
    );
    expect(sandboxFnMatch).toBeTruthy();
    const sandboxFnBody = sandboxFnMatch![1];
    expect(sandboxFnBody).toContain('if (used) *used = need;');
    expect(sandboxFnBody).toContain('if (!out) return xgr_return_hr(E_POINTER);');
    expect(sandboxFnBody).not.toMatch(/!used/);

    const consoleIdFnMatch = xsysSrc.match(/xsys_GetConsoleId\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    expect(consoleIdFnMatch?.[1]).toContain('if (used) *used = need;');
    expect(consoleIdFnMatch?.[1]).not.toMatch(/!used/);

    const appDevIdFnMatch = xsysSrc.match(
      /xsys_GetAppSpecificDeviceId\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/
    );
    expect(appDevIdFnMatch?.[1]).toContain('if (used) *used = need;');
    expect(appDevIdFnMatch?.[1]).not.toMatch(/!used/);

    // Verify XUser Gamertag max lengths & `xgt_XUserGetGamertag` optional `used == NULL`
    const xuserSrc = fs.readFileSync(
      path.join(repoRoot, 'electron/helpers/xgr_bridge/xuser.c'),
      'utf8'
    );
    expect(xuserSrc).toMatch(/char\s+gamertag\[16\];/);
    expect(xuserSrc).toMatch(/char\s+modern_gamertag\[97\];/);
    expect(xuserSrc).toMatch(/char\s+modern_suffix\[15\];/);
    expect(xuserSrc).toMatch(/char\s+unique_modern_gamertag\[101\];/);

    const gamertagFnMatch = xuserSrc.match(
      /xgt_XUserGetGamertag\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/
    );
    expect(gamertagFnMatch).toBeTruthy();
    expect(gamertagFnMatch![1]).toContain('if (used) *used = need;');
    expect(gamertagFnMatch![1]).toContain('if (!gamertag) return xgr_return_hr(E_INVALIDARG);');
    expect(gamertagFnMatch![1]).not.toMatch(/!used/);

    // Verify xgr_xml_pfn.c ancestor receipt fallback & gameinput_bridge.c active-device reading priority
    const xmlPfnSrc = fs.readFileSync(
      path.join(repoRoot, 'electron/helpers/xgr_bridge/xgr_xml_pfn.c'),
      'utf8'
    );
    expect(xmlPfnSrc).toContain('L".onelauncher-xbox-receipt.json"');
    expect(xmlPfnSrc).toContain('L".onelauncher-xbox-install.json"');
    expect(xmlPfnSrc).toContain('if (!g_xgr_cfg.packageFamilyName[0] && receipt_pfn[0])');

    const giSrc = fs.readFileSync(
      path.join(repoRoot, 'electron/helpers/xgr_bridge/gameinput_bridge.c'),
      'utf8'
    );
    expect(giSrc).toContain('GetAsyncKeyState((int)vk) & 0x8000');
    expect(giSrc).toContain('InterlockedCompareExchange(&g_mgr.focus_policy, 0, 0)');
    expect(giSrc).toContain('gi_is_process_focused(pol)');
    expect(giSrc).toContain('gi_snapshot_has_active_input(&cur->snap, kind_mask)');
  });

  it('installs an Xbox build on a merged cross-storefront card (id: "steam-2320") with steamAppId === undefined, full GDK metadata on completed, and immediate Xbox launch priority over uninstalled Steam', async () => {
    const fakeHome = path.join(tmpDir, 'fakeHome');
    const userDataDir = path.join(tmpDir, 'userData');
    const xboxLibRoot = path.join(fakeHome, 'Games', 'OneLauncher', 'Xbox');
    fs.mkdirSync(xboxLibRoot, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });

    const cik32 = crypto.randomBytes(32);
    const keyGuid = 'f1e2d3c4-b5a6-4789-8901-23456789abcd';
    const contentIdGuid = '87654321-4321-4321-8321-210987654321';
    const peExeBuf = buildValidMinimalPe64Buffer();
    const gameConfigXml = `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="MergedStudio.ArenaClassicII" Publisher="CN=AABBCCDD-1122-3344-5566-77889900AABB" Version="1.0.14.0" />
  <TitleId>6432DF20</TitleId>
  <MSAAppId>0000000048193752</MSAAppId>
  <ShellVisuals DefaultDisplayName="Synthetic Arena II" />
  <DesktopRegistration>
    <ExecutableList>
      <Executable Name="SynthArenaII_x64.exe" Id="Game" />
    </ExecutableList>
  </DesktopRegistration>
</Game>`;

    const msixvcPath = path.join(tmpDir, 'MergedArenaII.msixvc');
    const msixvcBytes = buildSyntheticMsixvcImage({
      regionIdInXts: false,
      cik32,
      keyGuid,
      contentIdGuid,
      gameConfigXml,
      files: [
        { path: 'Files/MicrosoftGame.config', data: Buffer.from(gameConfigXml, 'utf8') },
        { path: 'Files/SynthArenaII_x64.exe', data: peExeBuf },
      ],
    });
    fs.writeFileSync(msixvcPath, msixvcBytes);

    const emittedDownloadUpdates: any[] = [];
    const installRes = await launcherEngine.installGame(
      {
        gameId: 'steam-2320',
        steamAppId: 2320,
        title: 'Synthetic Arena II',
        platformId: 'xbox',
        platformGameId: '9NSYNTH2320',
        xboxProductId: '9NSYNTH2320',
        installDir: xboxLibRoot,
        contentId: contentIdGuid,
        msixvcPath,
      },
      {
        platform: 'darwin',
        homedir: fakeHome,
        userDataDir,
        xboxAuthProvider: {
          getStoreMsaToken: async () => 't=synthetic_store_ticket',
          ensureDeviceContext: async () => ({
            deviceMsToken: 't=synthetic_device_ticket',
            deviceKeyBuffer: Buffer.alloc(16, 0x22),
          }),
        },
        acquireContentCikFn: async () => ({
          contentId: contentIdGuid,
          keyId: keyGuid,
          cikBuffer: cik32,
          cikHex: cik32.toString('hex'),
          keys: [{ keyId: keyGuid, cikBuffer: cik32, cikHex: cik32.toString('hex') }],
        }),
        resolveXboxDeliveryFn: async () => ({
          contentId: contentIdGuid,
          packageFamilyName: 'MergedStudio.ArenaClassicII_3275kfvn8vcwc',
          packageFullName: 'MergedStudio.ArenaClassicII_1.0.14.0_x64__3275kfvn8vcwc',
          xboxTitleId: '6432DF20',
          msaAppId: '0000000048193752',
          maxDownloadSizeBytes: msixvcBytes.length,
          downloadUrls: ['http://127.0.0.1:9/unused-local-msixvc-path-used'],
          satisfyingEntitlementKeys: ['9NSYNTH2320:0010'],
        }),
        extractMsixvcFn: (extractOpts: any) =>
          msixvcStreamExtractor.extractMsixvcStream(extractOpts),
        onProgress: (snap: any) => emittedDownloadUpdates.push(snap),
      }
    );

    expect(installRes.success).toBe(true);
    expect(installRes.task?.steamAppId).toBeUndefined();
    expect(installRes.task?.installRequest?.steamAppId).toBeUndefined();

    // Wait for async worker extraction to reach `status: 'completed'`
    let completedTask: any = null;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const queue = launcherEngine.getDownloadQueue();
      const found = queue.find((t: any) => t.taskId === installRes.task.taskId);
      if (found && (found.status === 'completed' || found.status === 'failed')) {
        completedTask = found;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(completedTask).toBeTruthy();
    expect(completedTask.status).toBe('completed');
    expect(completedTask.steamAppId).toBeUndefined();
    expect(completedTask.xboxProductId).toBe('9NSYNTH2320');
    expect(completedTask.packageFamilyName).toMatch(/^MergedStudio\.ArenaClassicII_[0-9a-hjkmnp-tv-z]{13}$/);
    expect(completedTask.appUserModelId).toBe(`${completedTask.packageFamilyName}!Game`);
    expect(completedTask.xboxTitleId).toBe('6432DF20');
    expect(completedTask.scid).toBe('00000000-0000-0000-0000-00006432df20');
    expect(completedTask.msaAppId).toBe('0000000048193752');
    expect(completedTask.version).toBe('1.0.14.0');
    expect(completedTask.executablePath).toContain('SynthArenaII_x64.exe');

    // Set up isolated frontend LauncherService with an older persisted `preferredPlatformId: 'steam'`
    const memStorage = createMemoryStorage();
    memStorage.setItem(
      'one_launcher_game_launch_configs_v1',
      JSON.stringify({
        'steam-2320': {
          gameId: 'steam-2320',
          preferredPlatformId: 'steam',
          launchMethod: 'auto',
        },
      })
    );
    (globalThis as any).localStorage = memStorage;

    let downloadListener: ((payload: any) => void) | null = null;
    const installedEvents: any[] = [];
    const scanSpy = vi.fn(async () => ({
      success: true,
      installedGames: [
        {
          platformId: 'xbox' as const,
          platformGameId: '9NSYNTH2320',
          xboxProductId: '9NSYNTH2320',
          packageFamilyName: completedTask.packageFamilyName,
          appUserModelId: completedTask.appUserModelId,
          xboxTitleId: completedTask.xboxTitleId,
          scid: completedTask.scid,
          msaAppId: completedTask.msaAppId,
          version: completedTask.version,
          title: 'Synthetic Arena II',
          installPath: completedTask.finalInstallPath,
          executablePath: completedTask.executablePath,
          installSize: completedTask.totalBytes,
          runner: 'xbox_xgr',
          isWindowsBinaryOnMac: true,
        },
      ],
    }));
    const launchIpcSpy = vi.fn(async (req: any) => ({
      success: true,
      session: {
        sessionId: 'sess-merged-xbox-1',
        gameId: req.gameId,
        title: req.title,
        platformId: req.platformId,
        platformGameId: req.platformGameId,
        startedAt: new Date().toISOString(),
        launchMethod: 'compatibility_layer' as const,
        executablePath: req.executablePath,
        status: 'running' as const,
      },
    }));

    const eventTarget = new EventTarget();
    eventTarget.addEventListener('antigravity:game-installed', (ev: Event) => {
      installedEvents.push((ev as CustomEvent).detail);
    });

    (globalThis as any).window = {
      localStorage: memStorage,
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      electronAPI: {
        platform: 'darwin',
        onDownloadUpdated: (cb: (payload: any) => void) => {
          downloadListener = cb;
          return () => {
            downloadListener = null;
          };
        },
        onSessionUpdated: () => () => {},
        onHibernateStateChanged: () => () => {},
        getGameLaunchConfigs: async () => ({
          'steam-2320': {
            gameId: 'steam-2320',
            preferredPlatformId: 'steam',
            launchMethod: 'auto',
          },
        }),
        getRunningGames: async () => [],
        getDownloadQueue: async () => [],
        detectCompatibilityLayers: async () => [
          {
            id: 'crossover-26',
            type: 'crossover',
            name: 'CrossOver',
            version: '26.0',
            available: true,
            path: '/Applications/CrossOver.app',
          },
        ],
        scanAllInstalledGames: async () => ({ success: true, installedGames: [] }),
        launchGame: launchIpcSpy,
      },
    };

    const svc = new LauncherService();
    await svc.initialize();

    // Swap scanAllInstalledGames to return the newly extracted Xbox build when download finishes
    (globalThis as any).window.electronAPI.scanAllInstalledGames = scanSpy;
    expect(downloadListener).toBeTypeOf('function');

    // Emit the completed Xbox download on the merged `steam-2320` card
    downloadListener!({ task: completedTask, queue: [completedTask] });
    await new Promise((r) => setTimeout(r, 30));

    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(installedEvents.length).toBeGreaterThanOrEqual(1);
    expect(installedEvents[0]).toMatchObject({
      gameId: 'steam-2320',
      platformId: 'xbox',
      platformGameId: '9NSYNTH2320',
      xboxProductId: '9NSYNTH2320',
      packageFamilyName: completedTask.packageFamilyName,
      appUserModelId: completedTask.appUserModelId,
      xboxTitleId: '6432DF20',
      scid: '00000000-0000-0000-0000-00006432df20',
      msaAppId: '0000000048193752',
      version: '1.0.14.0',
      installed: true,
    });
    expect(installedEvents[0].steamAppId).toBeUndefined();

    // Construct the merged cross-storefront card where Steam is uninstalled and Xbox was just installed
    const mergedCard = makeCanonicalGameFixture({
      id: 'steam-2320',
      steamAppId: 2320,
      title: 'Synthetic Arena II',
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '2320',
          installed: false,
        },
        {
          platformId: 'xbox',
          platformGameId: '9NSYNTH2320',
          xboxProductId: '9NSYNTH2320',
          installed: false,
        },
      ],
    });

    // Even though saved launchConfig has `preferredPlatformId: 'steam'`, Steam is NOT installed,
    // so `getEffectivePlatformForGame` and `launchGame` MUST select installed `'xbox'`!
    const effPlat = svc.getEffectivePlatformForGame(mergedCard);
    expect(effPlat?.platformId).toBe('xbox');
    expect(effPlat?.installed).toBe(true);
    expect(effPlat?.packageFamilyName).toBe(completedTask.packageFamilyName);
    expect(effPlat?.xboxTitleId).toBe('6432DF20');
    expect(effPlat?.scid).toBe('00000000-0000-0000-0000-00006432df20');
    expect(effPlat?.msaAppId).toBe('0000000048193752');

    const launchOut = await svc.launchGame(mergedCard);
    expect(launchOut.success).toBe(true);
    expect(launchIpcSpy).toHaveBeenCalledTimes(1);
    const ipcPayload = launchIpcSpy.mock.calls[0][0];
    expect(ipcPayload.platformId).toBe('xbox');
    expect(ipcPayload.platformGameId).toBe('9NSYNTH2320');
    expect(ipcPayload.xboxProductId).toBe('9NSYNTH2320');
    expect(ipcPayload.packageFamilyName).toBe(completedTask.packageFamilyName);
    expect(ipcPayload.xboxTitleId).toBe('6432DF20');
    expect(ipcPayload.scid).toBe('00000000-0000-0000-0000-00006432df20');
    expect(ipcPayload.msaAppId).toBe('0000000048193752');
    expect(ipcPayload.executablePath).toBe(completedTask.executablePath);
  });
});

// ===========================================================================
// 12. Wave 2 Rich Media, OfflineVault Self-Healing, Cross-Store Steam
//     Enrichment, Universal Entity Resolution & Moving-Image Compaction
// ===========================================================================

describe('12. Wave 2 Rich Media, OfflineVault Self-Healing, Cross-Store Steam Enrichment & Moving-Image Compaction', () => {
  let tmpDir: string;
  let prevWindow: any;
  let prevDocument: any;
  let prevNavigatorDesc: PropertyDescriptor | undefined;
  let prevLocalStorage: any;
  let prevHTMLElement: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-domain12-'));
    prevWindow = (globalThis as any).window;
    prevDocument = (globalThis as any).document;
    prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    prevLocalStorage = (globalThis as any).localStorage;
    prevHTMLElement = (globalThis as any).HTMLElement;
    setDomPurifyFragmentBuilder(buildDomain12FragmentFromHtml);
    federatorMod.clearFederatorCaches();
    requestScheduler.reset();
    onlineLifecycleManager.triggerReconnectSweep();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setDomPurifyFragmentBuilder(null);
    federatorMod.clearFederatorCaches();
    requestScheduler.reset();
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
    if (prevDocument === undefined) {
      delete (globalThis as any).document;
    } else {
      (globalThis as any).document = prevDocument;
    }
    if (prevNavigatorDesc) {
      Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc);
    }
    if (prevLocalStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      (globalThis as any).localStorage = prevLocalStorage;
    }
    if (prevHTMLElement === undefined) {
      delete (globalThis as any).HTMLElement;
    } else {
      (globalThis as any).HTMLElement = prevHTMLElement;
    }
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts DisplayCatalog CMSVideos (HeroTrailer-first HLS + MP4 + 1280x720 thumbnails), capability chips, plain-text HTML formatting, sentinel release-date rejection, storefront_native stamping, and fetchXboxProductMetadata({ query }) autosuggest hydration', async () => {
    // 1. CMSVideos + Videos sorting (HeroTrailer -> Trailer -> SortOrder), deduplication & 1280x720 thumbnails
    const extractedMovies = xboxCatalogAndGamePass.extractDisplayCatalogMovies(
      {
        CMSVideos: [
          {
            VideoPurpose: 'Gameplay',
            SortOrder: 1,
            VideoPositionInfo: 'Gameplay Overview',
            HLS: '//streaming.xboxlive.com/videos/synth-vanguard/gameplay.m3u8',
            URI: 'http://streaming.xboxlive.com/videos/synth-vanguard/gameplay.mp4',
            PreviewImage: { Uri: '//store-images.s-microsoft.com/image/apps.9001.gameplay_thumb.png' },
          },
          {
            VideoPurpose: 'Trailer',
            SortOrder: 2,
            Title: 'Story Trailer',
            HLS: 'https://streaming.xboxlive.com/videos/synth-vanguard/story.m3u8',
            PreviewImage: { Uri: '//store-images.s-microsoft.com/image/apps.9001.story_thumb.png' },
          },
          {
            VideoPurpose: 'Trailer',
            SortOrder: 1,
            Title: 'Announce Trailer',
            URI: 'https://streaming.xboxlive.com/videos/synth-vanguard/announce.mp4',
            PreviewImage: { Uri: '//store-images.s-microsoft.com/image/apps.9001.announce_thumb.png' },
          },
          {
            VideoPurpose: 'HeroTrailer',
            SortOrder: 10,
            Title: 'Official Launch Hero Trailer',
            HLS: 'https://streaming.xboxlive.com/videos/synth-vanguard/hero_master.m3u8',
            URI: 'https://streaming.xboxlive.com/videos/synth-vanguard/hero_1080p.mp4',
            PreviewImage: { Uri: '//store-images.s-microsoft.com/image/apps.9001.hero_thumb.png' },
          },
        ],
        Videos: [
          // Duplicate stream URL must be deduplicated behind CMSVideos HeroTrailer
          {
            Purpose: 'HeroTrailer',
            SortOrder: 99,
            Title: 'Duplicate Hero Stream',
            HLS: 'https://streaming.xboxlive.com/videos/synth-vanguard/hero_master.m3u8',
          },
        ],
      },
      'https://store-images.s-microsoft.com/image/apps.9001.fallback.png?w=1280&h=720&q=85'
    );

    expect(extractedMovies).toHaveLength(4);
    expect(extractedMovies.map((m: any) => m.name)).toEqual([
      'Official Launch Hero Trailer',
      'Announce Trailer',
      'Story Trailer',
      'Gameplay Overview',
    ]);
    expect(extractedMovies[0]).toMatchObject({
      id: 100000,
      name: 'Official Launch Hero Trailer',
      hls: 'https://streaming.xboxlive.com/videos/synth-vanguard/hero_master.m3u8',
      mp4: {
        max: 'https://streaming.xboxlive.com/videos/synth-vanguard/hero_1080p.mp4',
        480: 'https://streaming.xboxlive.com/videos/synth-vanguard/hero_1080p.mp4',
      },
      thumbnail: 'https://store-images.s-microsoft.com/image/apps.9001.hero_thumb.png?w=1280&h=720&q=85',
    });
    expect(extractedMovies[3].hls).toBe(
      'https://streaming.xboxlive.com/videos/synth-vanguard/gameplay.m3u8'
    );
    expect(extractedMovies[3].mp4?.max).toBe(
      'https://streaming.xboxlive.com/videos/synth-vanguard/gameplay.mp4'
    );

    // 2. Properties.Attributes capability mapping & deduplication
    const extractedCategories = xboxCatalogAndGamePass.extractDisplayCatalogCategories({
      Properties: {
        XboxLiveGoldRequired: false,
        Attributes: [
          { Name: 'SinglePlayer' },
          { Name: 'XblOnlineCoop' },
          { Name: 'XPA' },
          { Name: 'RayTracing' },
          { Name: 'XblAchievements' },
          { Name: 'XblPresence' }, // Deduplicates with XblAchievements
          { Name: 'PcGamepad' },
          { Name: 'ConsoleGamepad' }, // Deduplicates with PcGamepad
          { Name: 'Capability4k' },
        ],
      },
    });
    expect(extractedCategories.map((c: any) => c.description)).toEqual([
      'Single-player',
      'Online Co-op',
      'Xbox Play Anywhere',
      'Ray Tracing',
      'Xbox Achievements',
      'Full controller support',
      '4K Ultra HD',
    ]);

    // 3. Plain-text paragraph/heading/bullet HTML formatting (leaving pre-existing HTML intact)
    const plainDesc = [
      'Forge your squad across uncharted star systems & orbital ruins.',
      '',
      'KEY FEATURES',
      '- Tactical 4-player co-op raids',
      '- Dynamic weather & destructible cover',
      '',
      'WORLD BUILDING',
      'Explore three interconnected biomes.',
      'Uncover ancient <relics> safely.',
    ].join('\n');

    const formattedHtml = xboxCatalogAndGamePass.formatPlainDescriptionToHtml(plainDesc);
    expect(formattedHtml).toContain(
      '<p>Forge your squad across uncharted star systems &amp; orbital ruins.</p>'
    );
    expect(formattedHtml).toContain('<h3 class="bb_tag">KEY FEATURES</h3>');
    expect(formattedHtml).toContain(
      '<ul><li>Tactical 4-player co-op raids</li><li>Dynamic weather &amp; destructible cover</li></ul>'
    );
    expect(formattedHtml).toContain('<h3 class="bb_tag">WORLD BUILDING</h3>');
    expect(formattedHtml).toContain(
      '<p>Explore three interconnected biomes.<br />Uncover ancient &lt;relics&gt; safely.</p>'
    );
    const preExistingHtml = '<div class="bb_paragraph"><video src="https://cdn.example/clip.mp4"></video></div>';
    expect(xboxCatalogAndGamePass.formatPlainDescriptionToHtml(preExistingHtml)).toBe(preExistingHtml);

    // 4. Sentinel release date rejection across both CJS DisplayCatalog & TS titleUtils
    for (const sentinel of [
      '9998-12-30T00:00:00Z',
      '2799-12-31T00:00:00Z',
      '0001-01-01T00:00:00Z',
      '2099-12-31T23:59:59Z',
      '1753-01-01T00:00:00Z',
    ]) {
      expect(xboxCatalogAndGamePass.sanitizeDisplayCatalogReleaseDate(sentinel)).toBe('');
      expect(sanitizeStoreReleaseDate(sentinel)).toBeUndefined();
      expect(parseReleaseYear(sentinel)).toBeNull();
    }
    expect(xboxCatalogAndGamePass.sanitizeDisplayCatalogReleaseDate('2024-09-18T16:00:00Z')).toBe(
      '2024-09-18'
    );
    expect(sanitizeStoreReleaseDate('2024-09-18T16:00:00Z')).toBe('2024-09-18');

    // 5. End-to-end syncXboxCatalog stamps metadataQuality: 'storefront_native' + enrichedSource: 'xbox'
    //    and falls back past sentinel MarketProperties OriginalReleaseDate to valid SKU release date
    const richProduct = buildDisplayCatalogGameFixture({
      productId: '9NSYNTH9001A',
      title: 'Synthetic Vanguard (PC)',
    });
    (richProduct.LocalizedProperties[0] as any).ProductDescription = plainDesc;
    (richProduct.LocalizedProperties[0] as any).CMSVideos = [
      {
        VideoPurpose: 'HeroTrailer',
        SortOrder: 1,
        Title: 'Launch Hero Trailer',
        HLS: 'https://streaming.xboxlive.com/videos/synth-vanguard/hero_master.m3u8',
        PreviewImage: { Uri: '//store-images.s-microsoft.com/image/apps.9001.hero_thumb.png' },
      },
    ];
    (richProduct.Properties as any).Attributes = [
      { Name: 'SinglePlayer' },
      { Name: 'XblOnlineCoop' },
      { Name: 'XPA' },
      { Name: 'RayTracing' },
    ];
    richProduct.MarketProperties[0].OriginalReleaseDate = '9998-12-30T00:00:00Z';
    (richProduct.DisplaySkuAvailabilities[0].Sku as any).MarketProperties = [
      { OriginalReleaseDate: '2024-09-18T00:00:00Z' },
    ];

    const syncFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/PCGAFD/entitlements/subscriptions')) {
        return new Response(JSON.stringify({ subscriptions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/PCGAFD/entitlements')) {
        return new Response(
          JSON.stringify({
            entitlements: [{ productId: '9NSYNTH9001A', acquisitionType: 'Single' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('displaycatalog.mp.microsoft.com/v7.0/products')) {
        return new Response(JSON.stringify({ Products: [richProduct] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });

    const syncRes = await xboxCatalogAndGamePass.syncXboxCatalog({
      storeToken: 't=synthetic_store_ticket',
      syncMode: 'owned_only',
      userDataDir: path.join(tmpDir, 'sync-cache'),
      fetchImpl: syncFetch,
      checkMinecraftJava: false,
    });

    expect(syncRes.games).toHaveLength(1);
    const syncedGame = syncRes.games[0];
    expect(syncedGame.title).toBe('Synthetic Vanguard');
    expect(syncedGame.releaseDate).toBe('2024-09-18');
    expect(syncedGame.enrichedMetadata.metadataQuality).toBe('storefront_native');
    expect(syncedGame.enrichedMetadata.enrichedSource).toBe('xbox');
    expect(syncedGame.enrichedMetadata.movies).toHaveLength(1);
    expect(syncedGame.enrichedMetadata.movies[0].hls).toBe(
      'https://streaming.xboxlive.com/videos/synth-vanguard/hero_master.m3u8'
    );
    expect(syncedGame.enrichedMetadata.categories.map((c: any) => c.description)).toEqual([
      'Single-player',
      'Online Co-op',
      'Xbox Play Anywhere',
      'Ray Tracing',
    ]);
    expect(syncedGame.enrichedMetadata.detailedDescription).toContain(
      '<h3 class="bb_tag">KEY FEATURES</h3>'
    );

    // 6. fetchXboxProductMetadata({ query }) autosuggest search hydration
    const autosuggestFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest')) {
        expect(url).toContain('query=Synthetic%20Vanguard');
        expect(url).toContain('productFamilyNames=Games');
        return new Response(
          JSON.stringify({
            Results: [
              {
                ProductFamilyName: 'Games',
                Products: [{ ProductId: '9NSYNTH9001A', Title: 'Synthetic Vanguard' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('displaycatalog.mp.microsoft.com/v7.0/products')) {
        return new Response(JSON.stringify({ Products: [richProduct] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });

    const queryMeta = await xboxCatalogAndGamePass.fetchXboxProductMetadata(
      { query: 'Synthetic Vanguard', limit: 3 },
      { userDataDir: path.join(tmpDir, 'autosuggest-cache'), fetchImpl: autosuggestFetch }
    );

    expect(queryMeta?.success).toBe(true);
    expect(queryMeta?.results).toHaveLength(1);
    expect(queryMeta?.results[0]).toMatchObject({
      productId: '9NSYNTH9001A',
      title: 'Synthetic Vanguard',
      releaseDate: '2024-09-18',
      metadataQuality: 'storefront_native',
      enrichedSource: 'xbox',
    });
    expect(queryMeta?.results[0].movies).toHaveLength(1);
    expect(queryMeta?.results[0].categories.map((c: any) => c.description)).toContain('Ray Tracing');
  });

  it('self-heals poisoned authoritative SQLite rows & duplicate xbox-<BigId> rows, unpins upgraded Microsoft->Steam cover blobs when online (preserving offline fallback), and preserves >512 KB multi-frame GIF89a byte-for-byte', async () => {
    const vaultUserData = path.join(tmpDir, 'vault-userdata');
    const emptyHome = path.join(tmpDir, 'empty-home');
    fs.mkdirSync(emptyHome, { recursive: true });

    // Create initial vault schema, then inject pre-fix poisoned state directly into SQLite
    const seedVault = offlineVaultMod.createOfflineVaultService({
      platform: 'darwin',
      homedir: emptyHome,
      userDataDir: vaultUserData,
      steamRoots: [],
      gogGalaxyRoots: [],
      heroicRoots: [],
      legendaryDirs: [],
      bottlePaths: [],
    });
    seedVault.init();
    const dbPath = seedVault.resolveVaultPaths().dbPath;
    seedVault.shutdown();

    const rawDb = new DatabaseSync(dbPath);
    const poisonedXboxEnriched = {
      name: 'Synthetic Bastion',
      shortDescription: 'Xbox storefront synopsis without Steam appId.',
      detailedDescription: '<p>Plain Xbox synopsis.</p>',
      aboutTheGame: '<p>Plain Xbox synopsis.</p>',
      headerImage: 'https://store-images.s-microsoft.com/image/apps.8844.hero.jpg?w=1920&h=1080',
      capsuleImage: 'https://store-images.s-microsoft.com/image/apps.8844.poster.jpg?w=600&h=900',
      developers: ['Bastion Works'],
      publishers: ['Bastion Works'],
      genres: ['Action'],
      tags: ['Action'],
      categories: [{ id: 1, description: 'Single-player' }],
      screenshots: [],
      movies: [],
      releaseDate: '2024-04-12',
      metadataQuality: 'authoritative', // Poisoned pre-fix quality lacking positive appId!
      enrichedSource: 'xbox',
      xboxDeliveryHints: {
        contentId: 'aaaa1111-2222-3333-4444-555566667777',
        packageFullName: 'BastionWorks.SyntheticBastion_1.2.0.0_x64__8wekyb3d8bbwe',
        wuCategoryId: 'bbbb1111-2222-3333-4444-555566667777',
        satisfyingEntitlementKeys: ['9NSYNTH8844A:0010'],
      },
    };
    const mergedPlatforms = [
      { platformId: 'steam', platformGameId: '884400', installed: false },
      {
        platformId: 'xbox',
        platformGameId: '9NSYNTH8844A',
        xboxProductId: '9NSYNTH8844A',
        packageFamilyName: 'BastionWorks.SyntheticBastion_8wekyb3d8bbwe',
        xboxTitleId: '44556677',
        installed: true,
      },
    ];

    rawDb
      .prepare(
        `INSERT INTO vault_games (
          game_id, canonical_title, steam_app_id, is_installed, is_favorited,
          platforms_json, summary_json, enriched_json, metadata_quality, updated_at, enriched_at
        ) VALUES (?, ?, ?, 1, 0, ?, ?, ?, 'authoritative', 1000, 1000)`
      )
      .run(
        'steam-884400',
        'Synthetic Bastion',
        884400,
        JSON.stringify(mergedPlatforms),
        JSON.stringify({ id: 'steam-884400', title: 'Synthetic Bastion', platforms: mergedPlatforms }),
        JSON.stringify(poisonedXboxEnriched)
      );

    // Seed orphaned duplicate `xbox-9NSYNTH8844A` game + asset row
    rawDb
      .prepare(
        `INSERT INTO vault_games (
          game_id, canonical_title, is_installed, is_favorited, metadata_quality, updated_at, enriched_at
        ) VALUES ('xbox-9NSYNTH8844A', 'Synthetic Bastion', 0, 0, 'storefront_native', 900, 900)`
      )
      .run();
    rawDb
      .prepare(
        `INSERT INTO game_media_assets (
          url_key, game_id, asset_role, ordinal, source_url, storage_kind, last_verified_at
        ) VALUES ('xbox-9NSYNTH8844A::cover::0', 'xbox-9NSYNTH8844A', 'cover', 0, 'https://store-images.s-microsoft.com/dup.jpg', 'pending', 900)`
      )
      .run();
    rawDb.close();

    // Re-open OfflineVaultService -> runStartupSelfHeal() executes automatically on init()
    let onlineNow = true;
    const msCoverBytes = buildValidJpegBuffer(256, 0x31);
    const steam2xCoverBytes = buildValidJpegBuffer(384, 0x72);
    const animatedGifBytes = buildSyntheticAnimatedGif89aBuffer({
      frameCount: 2,
      frame1PayloadBytes: 540 * 1024, // > 512 KB static GIF threshold!
    });
    const singleFrameGifBytes = buildSyntheticAnimatedGif89aBuffer({
      frameCount: 1,
      frame1PayloadBytes: 64,
    });

    expect(animatedGifBytes.length).toBeGreaterThan(512 * 1024);
    expect(offlineVaultMod.isAnimatedGifBuffer(animatedGifBytes)).toBe(true);
    expect(offlineVaultMod.isAnimatedGifBuffer(singleFrameGifBytes)).toBe(false);

    const msCoverUrl =
      'https://store-images.s-microsoft.com/image/apps.8844.poster.jpg?w=600&h=900&q=90&mode=scale';
    const steamCoverUrl =
      'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/884400/abcdef0123456789abcdef0123456789abcdef01/library_capsule_2x.jpg';
    const animatedGifUrl =
      'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/884400/extras/combat_showcase.gif';

    let failSteamCoverFetch = false;
    const mediaFetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === msCoverUrl) {
        return makeMockFetchBinaryResponse({
          status: 200,
          body: msCoverBytes,
          contentType: 'image/jpeg',
        });
      }
      if (url === steamCoverUrl) {
        if (failSteamCoverFetch) {
          throw new Error('Simulated offline network failure');
        }
        return makeMockFetchBinaryResponse({
          status: 200,
          body: steam2xCoverBytes,
          contentType: 'image/jpeg',
        });
      }
      if (url === animatedGifUrl) {
        return makeMockFetchBinaryResponse({
          status: 200,
          body: animatedGifBytes,
          contentType: 'image/gif',
        });
      }
      return makeMockFetchBinaryResponse({ status: 404, body: 'Not Found', contentType: 'text/plain' });
    });

    const nativeImageCreateSpy = vi.fn(() => ({
      isEmpty: () => false,
      getSize: () => ({ width: 600, height: 340 }),
      toJPEG: () => buildValidJpegBuffer(96, 0xee),
    }));

    const vault = offlineVaultMod.createOfflineVaultService({
      platform: 'darwin',
      homedir: emptyHome,
      userDataDir: vaultUserData,
      steamRoots: [],
      gogGalaxyRoots: [],
      heroicRoots: [],
      legendaryDirs: [],
      bottlePaths: [],
      isOnlineFn: () => onlineNow,
      fetchImpl: mediaFetchSpy,
      nativeImage: { createFromBuffer: nativeImageCreateSpy },
    });
    vault.init();

    try {
      // A1. Poisoned `steam-884400` row was downgraded to `storefront_native` and duplicate `xbox-9NSYNTH8844A` purged
      const healedDetail = vault.getGameDetail('steam-884400');
      expect(healedDetail?.metadataQuality).toBe('storefront_native');
      expect(healedDetail?.enrichedMetadata?.metadataQuality).toBe('storefront_native');
      expect(vault.getGameDetail('xbox-9NSYNTH8844A')).toBeNull();
      const orphanAssetCount = vault
        .ensureOpen()
        .prepare("SELECT COUNT(*) AS cnt FROM game_media_assets WHERE game_id = 'xbox-9NSYNTH8844A'")
        .get();
      expect(Number(orphanAssetCount?.cnt || 0)).toBe(0);

      // A2. Authoritative Steam metadata (`appId > 0`) now overwrites the downgraded row while preserving `xboxDeliveryHints`
      vault.saveGameDetail({
        gameId: 'steam-884400',
        steamAppId: 884400,
        canonicalTitle: 'Synthetic Bastion',
        metadataQuality: 'authoritative',
        enrichedMetadata: {
          appId: 884400,
          name: 'Synthetic Bastion',
          shortDescription: 'Authoritative Steam tactical RPG synopsis.',
          detailedDescription:
            '<p>Rich Steam description</p><video src="https://shared.fastly.steamstatic.com/clip.webm"></video>',
          aboutTheGame:
            '<p>Rich Steam description</p><video src="https://shared.fastly.steamstatic.com/clip.webm"></video>',
          headerImage: 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/884400/header.jpg',
          capsuleImage: steamCoverUrl,
          developers: ['Bastion Works'],
          publishers: ['Bastion Works'],
          genres: ['Action', 'RPG'],
          tags: ['Tactical'],
          categories: [{ id: 2, description: 'Single-player' }],
          screenshots: [],
          movies: [
            {
              id: 256900,
              name: 'Steam Official Trailer',
              thumbnail: 'https://shared.fastly.steamstatic.com/thumb.jpg',
              hls: 'https://video.fastly.steamstatic.com/store_trailers/884400/master.m3u8',
            },
          ],
          releaseDate: '12 Apr, 2024',
          metadataQuality: 'authoritative',
          enrichedSource: 'steam',
        },
      });

      const upgradedDetail = vault.getGameDetail('steam-884400');
      expect(upgradedDetail?.metadataQuality).toBe('authoritative');
      expect(upgradedDetail?.enrichedMetadata?.appId).toBe(884400);
      expect(upgradedDetail?.enrichedMetadata?.enrichedSource).toBe('steam');
      expect(upgradedDetail?.enrichedMetadata?.detailedDescription).toContain('<video');
      expect(upgradedDetail?.enrichedMetadata?.xboxDeliveryHints).toEqual({
        contentId: 'aaaa1111-2222-3333-4444-555566667777',
        packageFullName: 'BastionWorks.SyntheticBastion_1.2.0.0_x64__8wekyb3d8bbwe',
        wuCategoryId: 'bbbb1111-2222-3333-4444-555566667777',
        satisfyingEntitlementKeys: ['9NSYNTH8844A:0010'],
      });

      // B. Cover blob unpinning on MS Store -> Steam 2x upgrade (online vs offline preservation)
      const initialMsCoverRes = await vault.resolveMediaRequest({
        gameId: 'steam-884400',
        role: 'cover',
        ordinal: 0,
        url: msCoverUrl,
      });
      expect(initialMsCoverRes.source).toBe('upstream_persisted');
      expect(Buffer.compare(initialMsCoverRes.buffer, msCoverBytes)).toBe(0);

      // While offline, requesting the upgraded Steam 2x cover URL MUST preserve & serve the cached MS cover blob
      onlineNow = false;
      failSteamCoverFetch = true;
      const offlinePreservedRes = await vault.resolveMediaRequest({
        gameId: 'steam-884400',
        role: 'cover',
        ordinal: 0,
        url: steamCoverUrl,
      });
      expect(offlinePreservedRes.kind).toBe('file');
      expect(offlinePreservedRes.source).toBe('vault_blob');
      expect(Buffer.compare(fs.readFileSync(offlinePreservedRes.filePath), msCoverBytes)).toBe(0);

      // Back online: requesting the upgraded Steam 2x cover URL invalidates the old MS blob and stores/serves the Steam 2x blob
      onlineNow = true;
      failSteamCoverFetch = false;
      const onlineUpgradedRes = await vault.resolveMediaRequest({
        gameId: 'steam-884400',
        role: 'cover',
        ordinal: 0,
        url: steamCoverUrl,
      });
      expect(onlineUpgradedRes.source).toBe('upstream_persisted');
      expect(Buffer.compare(onlineUpgradedRes.buffer, steam2xCoverBytes)).toBe(0);

      const cachedSteamBlobRes = await vault.resolveMediaRequest({
        gameId: 'steam-884400',
        role: 'cover',
        ordinal: 0,
        url: steamCoverUrl,
      });
      expect(cachedSteamBlobRes.kind).toBe('file');
      expect(cachedSteamBlobRes.source).toBe('vault_blob');
      expect(Buffer.compare(fs.readFileSync(cachedSteamBlobRes.filePath), steam2xCoverBytes)).toBe(0);

      // C. Multi-frame animated GIF (> 512 KB) is preserved byte-for-byte as image/gif and NEVER flattened via nativeImage.toJPEG
      nativeImageCreateSpy.mockClear();
      const gifRes = await vault.resolveMediaRequest({
        gameId: 'steam-884400',
        role: 'inline_img',
        ordinal: 0,
        url: animatedGifUrl,
      });
      expect(nativeImageCreateSpy).not.toHaveBeenCalled();
      expect(gifRes.mimeType).toBe('image/gif');
      expect(gifRes.sizeBytes).toBe(animatedGifBytes.length);
      expect(Buffer.compare(gifRes.buffer, animatedGifBytes)).toBe(0);
      expect(gifRes.filePath.endsWith('.gif')).toBe(true);
      expect(Buffer.compare(fs.readFileSync(gifRes.filePath), animatedGifBytes)).toBe(0);
    } finally {
      vault.shutdown();
    }
  });

  it('rejects false-hit Xbox storefront_native metadata in steamApi.fetchGameMetadata, batch-hydrates SHA1 2x covers, and enforces monotonic Steam > Xbox sync merges while preserving xboxDeliveryHints', async () => {
    const memStorage = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: memStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true, userAgent: 'OneLauncherTest/1.0' },
      configurable: true,
    });

    const poisonedXboxVaultMeta: SteamEnrichedMetadata = {
      appId: 0,
      name: 'Synthetic Horizon',
      shortDescription: 'Xbox DisplayCatalog blurb.',
      detailedDescription: '<p>Plain Xbox DisplayCatalog paragraphs.</p>',
      aboutTheGame: '<p>Plain Xbox DisplayCatalog paragraphs.</p>',
      headerImage: 'https://store-images.s-microsoft.com/image/apps.8855.hero.jpg?w=1920&h=1080',
      capsuleImage: 'https://store-images.s-microsoft.com/image/apps.8855.poster.jpg?w=600&h=900',
      developers: ['Horizon Foundry'],
      publishers: ['Horizon Foundry'],
      releaseDate: '2024-11-05',
      genres: ['Action'],
      tags: ['Action'],
      categories: [{ id: 1, description: 'Single-player' }],
      screenshots: [],
      movies: [],
      systemRequirements: {},
      reviewSummary: {
        reviewScore: 0,
        reviewScoreDesc: 'No User Reviews',
        totalPositive: 0,
        totalNegative: 0,
        totalReviews: 0,
        positivePercent: 0,
      },
      metadataQuality: 'storefront_native',
      enrichedSource: 'xbox',
      xboxDeliveryHints: {
        contentId: 'cccc1111-2222-3333-4444-555566667777',
        packageFullName: 'HorizonFoundry.SyntheticHorizon_1.0.4.0_x64__8wekyb3d8bbwe',
        wuCategoryId: 'dddd1111-2222-3333-4444-555566667777',
        satisfyingEntitlementKeys: ['9NSYNTH8855A:0010'],
      },
    };

    const getGameDetailSpy = vi.fn(async () => ({
      gameId: 'steam-885500',
      enrichedMetadata: poisonedXboxVaultMeta,
      metadataQuality: 'storefront_native',
    }));
    const saveGameDetailSpy = vi.fn(async () => ({ success: true }));

    const winEvents = new EventTarget();
    (globalThis as any).window = {
      localStorage: memStorage,
      location: { hostname: 'one-launcher.local', port: '', protocol: 'app:' },
      addEventListener: winEvents.addEventListener.bind(winEvents),
      removeEventListener: winEvents.removeEventListener.bind(winEvents),
      dispatchEvent: winEvents.dispatchEvent.bind(winEvents),
      electronAPI: {
        isElectron: true,
        offlineVault: {
          getGameDetail: getGameDetailSpy,
          saveGameDetail: saveGameDetailSpy,
        },
      },
    };

    // Simulate poisoned IDB entry as well -> must be evicted & ignored
    vi.spyOn(indexedDbVault, 'vaultGet').mockResolvedValueOnce(poisonedXboxVaultMeta as any);
    const vaultDeleteSpy = vi.spyOn(indexedDbVault, 'vaultDelete').mockResolvedValue(true);
    vi.spyOn(indexedDbVault, 'vaultSet').mockResolvedValue(true);

    const sha1Hash = '0123456789abcdef0123456789abcdef01234567';
    const expected2xCapsule = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/885500/${sha1Hash}/library_capsule_2x.jpg`;
    const expectedSteamHeader = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/885500/${sha1Hash}/header.jpg`;
    const steamRichHtml =
      '<p>Master high-velocity mech combat.</p>' +
      '<span class="bb_img_ctn"><video autoplay muted loop poster="https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/885500/extras/boost_poster.jpg">' +
      '<source src="https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/885500/extras/boost.webm" type="video/webm" />' +
      '</video></span>';

    vi.spyOn(axios, 'get').mockImplementation((async (url: string) => {
      if (url.includes('/IStoreBrowseService/GetItems/v1/')) {
        return {
          status: 200,
          headers: {},
          data: {
            response: {
              store_items: [
                {
                  appid: 885500,
                  assets: {
                    asset_url_format: 'steam/apps/885500/${FILENAME}',
                    library_capsule_2x: `${sha1Hash}/library_capsule_2x.jpg`,
                    header: `${sha1Hash}/header.jpg`,
                    community_icon: 'icon_hash_885500',
                  },
                },
              ],
            },
          },
        };
      }
      if (url.includes('/api/appdetails?appids=885500')) {
        return {
          status: 200,
          headers: {},
          data: {
            '885500': {
              success: true,
              data: {
                steam_appid: 885500,
                name: 'Synthetic Horizon',
                short_description: 'Authoritative Steam high-velocity mech action.',
                detailed_description: steamRichHtml,
                about_the_game: steamRichHtml,
                header_image: expectedSteamHeader,
                developers: ['Horizon Foundry'],
                publishers: ['Horizon Foundry'],
                release_date: { coming_soon: false, date: '5 Nov, 2024' },
                genres: [{ id: '1', description: 'Action' }],
                categories: [
                  { id: 2, description: 'Single-player' },
                  { id: 22, description: 'Steam Achievements' },
                ],
                screenshots: [
                  {
                    id: 1,
                    path_thumbnail: 'https://shared.akamai.steamstatic.com/ss1_thumb.jpg',
                    path_full: 'https://shared.akamai.steamstatic.com/ss1_full.jpg',
                  },
                ],
                movies: [
                  {
                    id: 256991,
                    name: 'Official Steam Gameplay Trailer',
                    thumbnail: 'https://shared.akamai.steamstatic.com/movie_thumb.jpg',
                    hls_h264: 'https://video.akamai.steamstatic.com/store_trailers/885500/master.m3u8',
                    mp4: {
                      '480': 'https://video.akamai.steamstatic.com/store_trailers/885500/movie480.mp4',
                      max: 'https://video.akamai.steamstatic.com/store_trailers/885500/movie_max.mp4',
                    },
                  },
                ],
                platforms: { windows: true, mac: false, linux: true },
              },
            },
          },
        };
      }
      if (url.includes('/appreviews/885500')) {
        return {
          status: 200,
          headers: {},
          data: {
            query_summary: {
              review_score: 8,
              review_score_desc: 'Very Positive',
              total_positive: 920,
              total_negative: 80,
              total_reviews: 1000,
            },
          },
        };
      }
      return { status: 200, headers: {}, data: '' };
    }) as any);

    const apiSvc = new SteamApiService();
    const batchAssets = await apiSvc.fetchStoreBrowseAssetsBatch([885500]);
    expect(batchAssets.get(885500)?.capsuleImage).toBe(expected2xCapsule);
    expect(batchAssets.get(885500)?.headerImage).toBe(expectedSteamHeader);

    const liveSteamMeta = await apiSvc.fetchGameMetadata(885500);
    expect(vaultDeleteSpy).toHaveBeenCalledWith('enriched_metadata:885500');
    expect(getGameDetailSpy).toHaveBeenCalledWith('steam-885500');
    expect(liveSteamMeta).toBeTruthy();
    expect(liveSteamMeta?.appId).toBe(885500);
    expect(liveSteamMeta?.metadataQuality).toBe('authoritative');
    expect(liveSteamMeta?.enrichedSource).toBe('steam');
    expect(liveSteamMeta?.capsuleImage).toBe(expected2xCapsule);
    expect(liveSteamMeta?.detailedDescription).toContain('<video');
    expect(liveSteamMeta?.movies[0]?.hls).toBe(
      'https://video.akamai.steamstatic.com/store_trailers/885500/master.m3u8'
    );
    expect(saveGameDetailSpy).toHaveBeenCalledTimes(1);

    // sanitizeGameCatalog heals legacy Xbox authoritative-without-appId records to storefront_native
    const legacyPoisonedXboxCard = makeCanonicalGameFixture({
      id: 'xbox-9NSYNTH8855A',
      title: 'Synthetic Horizon',
      capsuleImage: poisonedXboxVaultMeta.capsuleImage,
      headerImage: poisonedXboxVaultMeta.headerImage,
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NSYNTH8855A',
          xboxProductId: '9NSYNTH8855A',
          installed: false,
        },
      ],
      enrichedMetadata: {
        ...poisonedXboxVaultMeta,
        metadataQuality: 'authoritative',
      },
    });
    const sanitizedLegacy = sanitizeGameCatalog([legacyPoisonedXboxCard]);
    expect(sanitizedLegacy[0]?.enrichedMetadata?.metadataQuality).toBe('storefront_native');

    // Subsequent Xbox catalog re-sync (`storefront_native`) via pickBestEnrichedMetadata & mergeStorefrontGames
    // NEVER clobbers Steam `authoritative` metadata, Steam 2x SHA1 cover, or `<video>` HTML, while preserving `xboxDeliveryHints`!
    const existingSteamEnrichedCard = makeCanonicalGameFixture({
      id: 'steam-885500',
      steamAppId: 885500,
      title: 'Synthetic Horizon',
      headerImage: expectedSteamHeader,
      capsuleImage: expected2xCapsule,
      shortDescription: liveSteamMeta!.shortDescription,
      detailedDescription: steamRichHtml,
      releaseDate: '5 Nov, 2024',
      platforms: [
        { platformId: 'steam', platformGameId: '885500', installed: false },
        {
          platformId: 'xbox',
          platformGameId: '9NSYNTH8855A',
          xboxProductId: '9NSYNTH8855A',
          packageFamilyName: 'HorizonFoundry.SyntheticHorizon_8wekyb3d8bbwe',
          xboxTitleId: '88550011',
          ownershipType: 'subscription',
          installed: true,
        },
      ],
      enrichedMetadata: liveSteamMeta!,
    });

    const incomingXboxResyncCard = makeCanonicalGameFixture({
      id: 'xbox-9NSYNTH8855A',
      title: 'Synthetic Horizon',
      isVerifiedEntitlement: true,
      headerImage: poisonedXboxVaultMeta.headerImage,
      capsuleImage: poisonedXboxVaultMeta.capsuleImage,
      shortDescription: poisonedXboxVaultMeta.shortDescription,
      detailedDescription: '<p>Plain Xbox DisplayCatalog paragraphs.</p>',
      releaseDate: '9998-12-30',
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NSYNTH8855A',
          xboxProductId: '9NSYNTH8855A',
          packageFamilyName: 'HorizonFoundry.SyntheticHorizon_8wekyb3d8bbwe',
          xboxTitleId: '88550011',
          ownershipType: 'subscription',
          gamePassTier: 'PC Game Pass',
          installed: true,
        },
      ],
      enrichedMetadata: poisonedXboxVaultMeta,
    });

    expect(
      pickPreferredCapsuleImage(expected2xCapsule, poisonedXboxVaultMeta.capsuleImage)
    ).toBe(expected2xCapsule);
    expect(
      pickPreferredCapsuleImage(poisonedXboxVaultMeta.capsuleImage, expected2xCapsule)
    ).toBe(expected2xCapsule);
    expect(
      pickPreferredDetailedDescription(steamRichHtml, '<p>Plain Xbox DisplayCatalog paragraphs.</p>')
    ).toBe(steamRichHtml);

    const bestMergedMeta = pickBestEnrichedMetadata(liveSteamMeta!, poisonedXboxVaultMeta);
    expect(bestMergedMeta?.metadataQuality).toBe('authoritative');
    expect(bestMergedMeta?.enrichedSource).toBe('steam');
    expect(bestMergedMeta?.appId).toBe(885500);
    expect(bestMergedMeta?.detailedDescription).toBe(steamRichHtml);
    expect(bestMergedMeta?.xboxDeliveryHints).toEqual(poisonedXboxVaultMeta.xboxDeliveryHints);

    const mergedAfterXboxResync = mergeStorefrontGames(
      [existingSteamEnrichedCard],
      [incomingXboxResyncCard],
      'xbox'
    );
    expect(mergedAfterXboxResync).toHaveLength(1);
    const survivor = mergedAfterXboxResync[0];
    expect(survivor.id).toBe('steam-885500');
    expect(survivor.steamAppId).toBe(885500);
    expect(survivor.capsuleImage).toBe(expected2xCapsule);
    expect(survivor.headerImage).toBe(expectedSteamHeader);
    expect(survivor.detailedDescription).toBe(steamRichHtml);
    expect(survivor.releaseDate).toBe('5 Nov, 2024');
    expect(survivor.enrichedMetadata?.metadataQuality).toBe('authoritative');
    expect(survivor.enrichedMetadata?.enrichedSource).toBe('steam');
    expect(survivor.enrichedMetadata?.xboxDeliveryHints).toEqual(
      poisonedXboxVaultMeta.xboxDeliveryHints
    );
  });

  it('resolves universal cross-store entity & SteamMatcher edge cases (Watch Dogs®2, SimCity/Disney•Pixar compounds, Year 2 Edition, same-studio port vs reboot collision, 2-char "Fe", and 1-word truncated /search/results/ fallback)', async () => {
    const memStorage = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: memStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true, userAgent: 'OneLauncherTest/1.0' },
      configurable: true,
    });
    (globalThis as any).window = {
      localStorage: memStorage,
      location: { hostname: 'one-launcher.local', port: '', protocol: 'app:' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };

    // 1. Trademark symbol glued directly to sequel numeral: `Watch Dogs®2` -> `Watch Dogs 2`
    expect(normalizeTitleKey('Watch Dogs®2')).toBe('watch dogs 2');
    expect(isSequelMismatch('Watch Dogs®2', 'Watch Dogs 2')).toBe(false);
    const wd2Eval = computeEntityMatchConfidence(
      { title: 'Watch Dogs®2' },
      { title: 'Watch Dogs 2' }
    );
    expect(wd2Eval.titleScore).toBe(100);
    expect(wd2Eval.isAccepted).toBe(true);

    // 2. Compound word alignment: `Sim City` <-> `SimCity` and `DisneyPixar` <-> `Disney•Pixar`
    expect(splitCamelCaseTitle('SimCity')).toBe('Sim City');
    expect(alignCompoundWordTokens(['sim', 'city'], ['simcity'])).toEqual([
      ['simcity'],
      ['simcity'],
    ]);
    expect(computeTitleSimilarity('Sim City', 'SimCity')).toBe(1);
    expect(
      computeEntityMatchConfidence({ title: 'Sim City' }, { title: 'SimCity' })
    ).toMatchObject({ titleScore: 100, isAccepted: true });

    expect(computeTitleSimilarity('DisneyPixar', 'Disney•Pixar')).toBe(1);
    expect(
      computeEntityMatchConfidence(
        { title: 'DisneyPixar Synthetic Racers' },
        { title: 'Disney•Pixar Synthetic Racers' }
      )
    ).toMatchObject({ titleScore: 100, isAccepted: true });

    // 3. `Year 2 Edition` live-service suffix MUST NOT trigger sequel mismatch
    expect(stripYearEditionPhrases('Tactical Siege: Year 2 Edition')).toBe('Tactical Siege');
    expect(extractSequelIdentifier('Tactical Siege: Year 2 Edition')).toBeNull();
    expect(isSequelMismatch('Tactical Siege: Year 2 Edition', 'Tactical Siege')).toBe(false);
    const year2Eval = computeEntityMatchConfidence(
      { title: 'Tactical Siege: Year 2 Edition' },
      { title: 'Tactical Siege' }
    );
    expect(year2Eval.isAccepted).toBe(true);
    expect(year2Eval.confidence).toBeGreaterThanOrEqual(92);

    // 4. Later storefront port date (2021 MS Store port of 2013 original by same developer)
    //    is exempted from `-35` reboot penalty, while true different-developer reboots remain blocked!
    const sameDevPortEval = computeEntityMatchConfidence(
      {
        title: 'Synthetic State of Survival',
        releaseYear: '2021-05-18',
        developers: ['Undead Horizon Labs'],
      },
      {
        title: 'Synthetic State of Survival',
        releaseYear: 2013,
        developers: ['Undead Horizon Labs LLC'],
      }
    );
    expect(sameDevPortEval.developerBonus).toBe(12);
    expect(sameDevPortEval.yearAdjustment).toBe(0);
    expect(sameDevPortEval.isRebootCollision).toBe(false);
    expect(sameDevPortEval.isAccepted).toBe(true);

    const diffDevRebootEval = computeEntityMatchConfidence(
      {
        title: 'SyntheticShadow',
        releaseYear: 2017,
        developers: ['Modern Reboot Studio'],
      },
      {
        title: 'SyntheticShadow',
        releaseYear: 2006,
        developers: ['Retro Classic Software'],
      }
    );
    expect(diffDevRebootEval.developerBonus).toBe(0);
    expect(diffDevRebootEval.yearAdjustment).toBe(-35);
    expect(diffDevRebootEval.isRebootCollision).toBe(true);
    expect(diffDevRebootEval.isAccepted).toBe(false);

    // 5. 2-character title (`"Fe"`) + `Watch Dogs®2` + 1-word truncated `storesearch` -> `/search/results/` fallback
    const requestedUrls: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation((async (url: string) => {
      requestedUrls.push(url);
      if (url.includes('/api/storesearch/?term=watch%20dogs%202')) {
        return {
          status: 200,
          headers: {},
          data: {
            items: [{ id: 990447, name: 'Watch_Dogs 2' }],
          },
        };
      }
      if (url.includes('/api/storesearch/?term=fe&')) {
        return {
          status: 200,
          headers: {},
          data: {
            items: [
              { id: 990001, name: 'Feudal Tactics' },
              { id: 990002, name: 'Feral Frontier' },
              { id: 991225, name: 'Fe' },
            ],
          },
        };
      }
      if (url.includes('/api/storesearch/?term=synthetica&')) {
        // Return 10 non-matching DLC/soundtrack/sequel items to simulate truncated top-10 storesearch flood
        return {
          status: 200,
          headers: {},
          data: {
            items: Array.from({ length: 10 }, (_, idx) => ({
              id: 993000 + idx,
              name: idx % 2 === 0 ? `Synthetica 2 - Pack ${idx}` : `Synthetica Soundtrack Vol ${idx}`,
            })),
          },
        };
      }
      if (url.includes('/search/results/?term=synthetica&json=1&category1=998')) {
        return {
          status: 200,
          headers: {},
          data: {
            items: [
              {
                name: 'Synthetica 2',
                logo: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/994412/capsule_sm_120.jpg',
              },
              {
                name: 'Synthetica',
                logo: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/994411/capsule_sm_120.jpg',
              },
            ],
          },
        };
      }
      return { status: 200, headers: {}, data: { items: [] } };
    }) as any);

    const matcher = new SteamMatcherService();
    matcher.clearCache();

    const wd2AppId = await matcher.matchGameToSteam('Watch Dogs®2');
    expect(wd2AppId).toBe(990447);

    const feAppId = await matcher.matchGameToSteam('Fe', {
      releaseYear: '2018-02-16',
      developers: ['Zoink'],
    });
    expect(feAppId).toBe(991225);

    const truncatedFallbackAppId = await matcher.matchGameToSteam('Synthetica', {
      releaseYear: '2022-08-10',
      developers: ['Synth Works'],
    });
    expect(truncatedFallbackAppId).toBe(994411);
    expect(
      requestedUrls.some((u) =>
        u.includes('/search/results/?term=synthetica&json=1&category1=998&cc=us&l=english')
      )
    ).toBe(true);
  });

  it('compacts rich <video> HTML safely up to 35,000 chars (rewinding unclosed <video> blocks) and live-upgrades Xbox storefront_native games in SteamStorePage with normalized // URLs and inline <video> playback', async () => {
    // 1. compactGameForStorage preserves <video> moving-image HTML > 12,000 chars up to 35,000 chars intact
    const videoBlockA =
      '<span class="bb_img_ctn"><video autoplay muted loop playsinline poster="https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/clip_a.jpg">' +
      '<source src="https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/clip_a.webm" type="video/webm" />' +
      '</video></span>';
    const fillerParagraphs22k = '<p>' + 'Tactical squad telemetry &amp; orbital recon. '.repeat(480) + '</p>';
    const html24k = `${videoBlockA}\n${fillerParagraphs22k}\n${videoBlockA}`;
    expect(html24k.length).toBeGreaterThan(20_000);
    expect(html24k.length).toBeLessThan(35_000);

    const compactedUnder35k = compactGameForStorage(
      makeCanonicalGameFixture({
        id: 'steam-995501',
        steamAppId: 995501,
        title: 'Synthetic Vanguard Prime',
        platforms: [{ platformId: 'steam', platformGameId: '995501', installed: false }],
        detailedDescription: html24k,
        enrichedMetadata: {
          appId: 995501,
          name: 'Synthetic Vanguard Prime',
          shortDescription: 'Rich moving-image showcase.',
          detailedDescription: html24k,
          aboutTheGame: html24k,
          headerImage: 'https://shared.akamai.steamstatic.com/header.jpg',
          developers: ['Vanguard Lab'],
          publishers: ['Vanguard Lab'],
          releaseDate: '10 Oct, 2024',
          genres: ['Action'],
          tags: [],
          categories: [],
          screenshots: [],
          movies: [],
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 0,
            reviewScoreDesc: '',
            totalPositive: 0,
            totalNegative: 0,
            totalReviews: 0,
            positivePercent: 0,
          },
          metadataQuality: 'authoritative',
          enrichedSource: 'steam',
        },
      })
    );
    expect(compactedUnder35k.detailedDescription).toBe(html24k);
    expect(compactedUnder35k.enrichedMetadata?.detailedDescription).toBe(html24k);
    // Duplicate aboutTheGame === detailedDescription is deduplicated to '' in storage compaction
    expect(compactedUnder35k.enrichedMetadata?.aboutTheGame).toBe('');

    // 2. Exceeding 35,000 chars mid-<video> rewinds cleanly BEFORE the unclosed <span class="bb_img_ctn"><video> block
    const prefixNear35k =
      videoBlockA + '<p>' + 'Deep-space tactical chronicle segment. '.repeat(887) + '</p>';
    expect(prefixNear35k.length).toBeGreaterThan(34_850);
    expect(prefixNear35k.length).toBeLessThan(34_990);
    const tailVideoCutMidway =
      '<span class="bb_img_ctn"><video autoplay muted loop poster="https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/tail_poster.jpg">' +
      '<source src="https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/tail_clip.webm" type="video/webm" />' +
      '<source src="https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/tail_clip.mp4" type="video/mp4" />' +
      '</video></span><p>Trailing paragraph past 35k</p>';
    const oversizedHtml = prefixNear35k + tailVideoCutMidway;
    expect(oversizedHtml.length).toBeGreaterThan(35_200);

    const compactedOver35k = compactGameForStorage(
      makeCanonicalGameFixture({
        id: 'steam-995501',
        steamAppId: 995501,
        title: 'Synthetic Vanguard Prime',
        platforms: [{ platformId: 'steam', platformGameId: '995501', installed: false }],
        detailedDescription: oversizedHtml,
      })
    );
    const rewoundHtml = compactedOver35k.detailedDescription!;
    expect(rewoundHtml.length).toBeLessThanOrEqual(35_000);
    expect(rewoundHtml).toBe(prefixNear35k);
    expect(rewoundHtml).toContain('clip_a.webm');
    expect(rewoundHtml).not.toContain('tail_poster.jpg');
    expect((rewoundHtml.match(/<video\b/gi) || []).length).toBe(
      (rewoundHtml.match(/<\/video>/gi) || []).length
    );
    expect(truncateHtmlSafely('<p>Entity safe &amp;</p>', 19)).toBe('<p>Entity safe ');

    // 3. SteamStorePage live upgrade from Xbox `storefront_native` -> Steam `authoritative`,
    //    preserving `xboxDeliveryHints`, normalizing `//` URLs on <video>/<source>/<img srcset>,
    //    and mounting playing inline <video> moving images when online!
    const memStorage = createMemoryStorage();
    const winEvents = new EventTarget();
    const docEvents = new EventTarget();
    (globalThis as any).HTMLElement = Domain12HTMLElement;
    Object.defineProperty(globalThis, 'localStorage', {
      value: memStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true, userAgent: 'OneLauncherTest/1.0' },
      configurable: true,
    });
    (globalThis as any).window = {
      localStorage: memStorage,
      location: { hostname: 'one-launcher.local', port: '', protocol: 'app:' },
      innerWidth: 1440,
      innerHeight: 900,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      addEventListener: winEvents.addEventListener.bind(winEvents),
      removeEventListener: winEvents.removeEventListener.bind(winEvents),
      dispatchEvent: winEvents.dispatchEvent.bind(winEvents),
      electronAPI: {
        isElectron: true,
        platform: 'darwin',
        offlineVault: {
          getGameDetail: vi.fn(async () => null),
          saveGameDetail: vi.fn(async () => ({ success: true })),
        },
      },
    };
    (globalThis as any).document = {
      hidden: false,
      visibilityState: 'visible',
      documentElement: new Domain12HTMLElement('html'),
      body: new Domain12HTMLElement('body'),
      getElementById: () => null,
      addEventListener: docEvents.addEventListener.bind(docEvents),
      removeEventListener: docEvents.removeEventListener.bind(docEvents),
      dispatchEvent: docEvents.dispatchEvent.bind(docEvents),
      createElement: (tag: string) => new Domain12HTMLElement(tag),
      createDocumentFragment: () => new Domain12DocumentFragment(),
    };

    const xboxHints = {
      contentId: '11112222-3333-4444-5555-666677778888',
      packageFullName: 'VanguardLab.SyntheticVanguard_1.0.0.0_x64__8wekyb3d8bbwe',
      wuCategoryId: '99998888-7777-6666-5555-444433332222',
      satisfyingEntitlementKeys: ['9NSYNTH9955A:0010'],
    };

    const initialXboxMatchedGame = makeCanonicalGameFixture({
      id: 'steam-995501',
      steamAppId: 995501,
      title: 'Synthetic Vanguard Prime',
      headerImage: 'https://store-images.s-microsoft.com/image/apps.9955.hero.png?w=1920&h=1080',
      capsuleImage: 'https://store-images.s-microsoft.com/image/apps.9955.poster.png?w=600&h=900',
      shortDescription: 'Baseline Xbox storefront synopsis.',
      detailedDescription: '<p>Baseline Xbox storefront description.</p>',
      releaseDate: '2024-10-10',
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NSYNTH9955A',
          xboxProductId: '9NSYNTH9955A',
          packageFamilyName: 'VanguardLab.SyntheticVanguard_8wekyb3d8bbwe',
          xboxTitleId: '995501AA',
          installed: true,
        },
      ],
      enrichedMetadata: {
        appId: 0,
        name: 'Synthetic Vanguard Prime',
        shortDescription: 'Baseline Xbox storefront synopsis.',
        detailedDescription: '<p>Baseline Xbox storefront description.</p>',
        aboutTheGame: '<p>Baseline Xbox storefront description.</p>',
        headerImage: 'https://store-images.s-microsoft.com/image/apps.9955.hero.png?w=1920&h=1080',
        capsuleImage: 'https://store-images.s-microsoft.com/image/apps.9955.poster.png?w=600&h=900',
        developers: ['Vanguard Lab'],
        publishers: ['Vanguard Lab'],
        releaseDate: '2024-10-10',
        genres: ['Action'],
        tags: ['Action'],
        categories: [{ id: 1, description: 'Single-player' }],
        screenshots: [],
        movies: [],
        systemRequirements: {},
        reviewSummary: {
          reviewScore: 0,
          reviewScoreDesc: '',
          totalPositive: 0,
          totalNegative: 0,
          totalReviews: 0,
          positivePercent: 0,
        },
        metadataQuality: 'storefront_native',
        enrichedSource: 'xbox',
        xboxDeliveryHints: xboxHints,
      },
    });

    const upgradedCapsule2x =
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/995501/fedcba9876543210fedcba9876543210fedcba98/library_capsule_2x.jpg';
    const upgradedHeader =
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/995501/fedcba9876543210fedcba9876543210fedcba98/header.jpg';
    const protocolRelativeAboutHtml = `
      <div class="bb_paragraph">Live Steam combat moving-image showcase:</div>
      <img
        src="//shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/key_art_1x.png"
        srcset="//shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/key_art_1x.png 1x, //shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/key_art_2x.png 2x"
      />
      <div class="bb_img_ctn">
        <video
          poster="//shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/finisher_poster.avif"
          src="//shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/finisher_loop.webm"
        >
          <source src="//shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/finisher_loop.mp4" type="video/mp4" />
        </video>
      </div>
    `;

    vi.spyOn(steamApi, 'fetchStoreBrowseAssets').mockResolvedValue({
      capsuleImage: upgradedCapsule2x,
      headerImage: upgradedHeader,
      ts: Date.now(),
    });
    vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue({
      capsuleImage: upgradedCapsule2x,
      headerImage: upgradedHeader,
      ts: Date.now(),
    });
    vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue({
      appId: 995501,
      name: 'Synthetic Vanguard Prime',
      shortDescription: 'Authoritative Steam moving-image edition.',
      detailedDescription: protocolRelativeAboutHtml,
      aboutTheGame: protocolRelativeAboutHtml,
      headerImage: upgradedHeader,
      capsuleImage: upgradedCapsule2x,
      developers: ['Vanguard Lab'],
      publishers: ['Vanguard Lab'],
      releaseDate: '10 Oct, 2024',
      genres: ['Action'],
      tags: ['Co-op'],
      categories: [{ id: 2, description: 'Single-player' }],
      screenshots: [
        {
          id: 1,
          pathThumbnail: 'https://shared.akamai.steamstatic.com/ss_thumb.jpg',
          pathFull: 'https://shared.akamai.steamstatic.com/ss_full.jpg',
        },
      ],
      movies: [
        {
          id: 257001,
          name: 'Official Launch Trailer',
          thumbnail: 'https://shared.akamai.steamstatic.com/movie_thumb.jpg',
          hls: 'https://video.akamai.steamstatic.com/store_trailers/995501/master.m3u8',
        },
      ],
      systemRequirements: { minimum: 'OS: Windows 10 64-bit' },
      reviewSummary: {
        reviewScore: 9,
        reviewScoreDesc: 'Overwhelmingly Positive',
        totalPositive: 1900,
        totalNegative: 50,
        totalReviews: 1950,
        positivePercent: 97,
      },
      metadataQuality: 'authoritative',
      enrichedSource: 'steam',
    });
    vi.spyOn(steamAchievementsService, 'fetchPlayerGameAchievements').mockResolvedValue(null);
    vi.spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame').mockResolvedValue(null as any);
    vi.spyOn(launcherService, 'isInGameHibernating').mockReturnValue(false);
    vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);

    const onGameUpdated = vi.fn();
    const page = createDomain12DeepRenderer(SteamStorePage, {
      game: initialXboxMatchedGame,
      collections: [],
      onBackToLibrary: () => {},
      onManageCollections: () => {},
      onToggleInstallStatus: () => {},
      onGameUpdated,
    });

    page.render();
    await new Promise((r) => setTimeout(r, 25));
    page.render();

    expect(onGameUpdated).toHaveBeenCalledTimes(1);
    const updatedGame: CanonicalGame = onGameUpdated.mock.calls[0][0];
    expect(updatedGame.capsuleImage).toBe(upgradedCapsule2x);
    expect(updatedGame.headerImage).toBe(upgradedHeader);
    expect(updatedGame.enrichedMetadata?.metadataQuality).toBe('authoritative');
    expect(updatedGame.enrichedMetadata?.enrichedSource).toBe('steam');
    expect(updatedGame.enrichedMetadata?.appId).toBe(995501);
    expect(updatedGame.enrichedMetadata?.xboxDeliveryHints).toEqual(xboxHints);

    const aboutContainer = page.getHostElementByTestId('about-this-game-content');
    expect(aboutContainer).toBeDefined();

    const videos = aboutContainer!.querySelectorAll('video');
    expect(videos).toHaveLength(1);
    const mountedVideo = videos[0];
    expect(mountedVideo.autoplay).toBe(true);
    expect(mountedVideo.muted).toBe(true);
    expect(mountedVideo.loop).toBe(true);
    expect(mountedVideo.playsInline).toBe(true);
    expect(mountedVideo.paused).toBe(false);
    expect(mountedVideo.getAttribute('src')).toBe(
      'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/finisher_loop.webm'
    );
    expect(mountedVideo.getAttribute('poster')).toContain('ol-media://asset?');
    expect(mountedVideo.getAttribute('poster')).toContain('role=inline_poster');
    expect(mountedVideo.getAttribute('poster')).toContain(
      encodeURIComponent(
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/finisher_poster.avif'
      )
    );
    expect(mountedVideo.getAttribute('poster')).toContain('xboxProductId=9NSYNTH9955A');

    const sources = mountedVideo.querySelectorAll('source');
    expect(sources).toHaveLength(1);
    expect(sources[0].getAttribute('src')).toBe(
      'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/finisher_loop.mp4'
    );

    const imgs = aboutContainer!.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toContain('ol-media://asset?');
    expect(imgs[0].getAttribute('src')).toContain('role=inline_img');
    expect(imgs[0].getAttribute('srcset')).toBe(
      'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/key_art_1x.png 1x, https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/995501/extras/key_art_2x.png 2x'
    );

    page.unmount();
  });
});

