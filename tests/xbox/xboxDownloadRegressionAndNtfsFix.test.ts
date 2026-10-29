import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import * as crypto from 'node:crypto';

import {
  xboxDeviceClep,
  xboxCatalogAndGamePass,
  msixvcXvdParser,
  msixvcStreamExtractor,
  buildValidMinimalPe64Buffer,
  buildSyntheticUserData,
  buildDisplayCatalogGameFixture,
} from '../helpers/xboxTestHarness';

const nodeRequire = createRequire(import.meta.url);
const diskAndVolumeInspector = nodeRequire('../../electron/launcher/diskAndVolumeInspector.cjs');
const downloadQueueCoordinator = nodeRequire('../../electron/launcher/downloadQueueCoordinator.cjs');

// ============================================================================
// Hermetic Offline Socket Guard (forbids any external TCP connection)
// ============================================================================

let sharedRsaPrivateKeyPem = '';
let sharedRsaModulusB64 = '';
let sharedRsaExponentB64 = '';

beforeAll(() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  sharedRsaPrivateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  sharedRsaModulusB64 = Buffer.from(jwk.n, 'base64url').toString('base64');
  sharedRsaExponentB64 = Buffer.from(jwk.e, 'base64url').toString('base64');
});

function installHermeticOfflineSocketGuard() {
  const origConnect = net.Socket.prototype.connect;
  return vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: any[]
  ) {
    const first = args[0];
    const host =
      typeof first === 'object' && first !== null && 'host' in first
        ? String((first as { host?: string }).host || '127.0.0.1')
        : typeof args[1] === 'string'
          ? args[1]
          : '127.0.0.1';
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const isUnixPipe = typeof first === 'string' || (typeof first === 'object' && first && 'path' in first);
    if (!isLoopback && !isUnixPipe) {
      throw new Error(`Hermetic test guard blocked outbound TCP connection to "${host}"`);
    }
    return (origConnect as any).apply(this, args);
  });
}

// ============================================================================
// Synthetic Server-Signed `<License>` (`0x00cc` + W3C XML-DSig) Builders
// ============================================================================

function buildServerSignedSpLicenseBuffer0x00cc(options: {
  deviceKey16?: Buffer;
  licenseIdGuid?: string;
  packageFullName?: string;
  contentKeys?: Array<{ keyIdGuid: string; cik32: Buffer }>;
  encryptedDeviceKey16?: Buffer;
  clepRsaPrivateKeyPem?: string;
  signatureOrigin?: number;
  headerCoversSignatureBlock?: boolean;
}): Buffer {
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

  if (options.encryptedDeviceKey16) {
    const schedKey = Buffer.from('102030405060708090a0b0c0d0e0f001', 'hex');
    const schedule232 = xboxDeviceClep.buildKeyScheduleForTargetKey(schedKey);
    const encDevKey16 = xboxDeviceClep.encryptCbcZeroIv(schedKey, options.encryptedDeviceKey16);
    const payload534 = Buffer.alloc(534, 0);
    payload534.writeUInt16LE(534, 0);
    payload534.writeUInt32LE(1, 2);
    schedule232.copy(payload534, 6);
    encDevKey16.copy(payload534, 518);
    pushTlv(xboxDeviceClep.BLOCK_ID.ENCRYPTED_DEVICE_KEY, payload534);
  }

  if (options.clepRsaPrivateKeyPem) {
    const schedKey = Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'hex');
    const schedule232 = xboxDeviceClep.buildKeyScheduleForTargetKey(schedKey);
    const rsaBlob544 = xboxDeviceClep.exportPemToBcryptRsa2Blob(options.clepRsaPrivateKeyPem);
    const encRsa544 = xboxDeviceClep.encryptCbcZeroIv(schedKey, rsaBlob544.subarray(0, 544));
    const payload780 = Buffer.alloc(780, 0);
    payload780.writeUInt32LE(1, 0);
    encRsa544.copy(payload780, 4);
    schedule232.copy(payload780, 548);
    pushTlv(xboxDeviceClep.BLOCK_ID.CLEP_SIGN_STATE, payload780);
  }

  if (options.contentKeys && options.contentKeys.length > 0) {
    if (!options.deviceKey16) {
      throw new Error('deviceKey16 is required when wrapping contentKeys');
    }
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

  // Terminal `0x00cc` (`SIGNATURE_BLOCK`: u16 algorithmId=1, u16 signatureOrigin, 64B ECDSA P-256 signature)
  const sigPayload68 = Buffer.alloc(68, 0);
  sigPayload68.writeUInt16LE(1, 0); // algorithmId = 1 (ECDSA P-256)
  sigPayload68.writeUInt16LE(options.signatureOrigin ?? 1, 2);
  crypto.createHash('sha512').update(Buffer.concat(tlvChunks)).digest().copy(sigPayload68, 4, 0, 64);
  const sigTlvHdr = Buffer.alloc(8);
  sigTlvHdr.writeUInt32LE(xboxDeviceClep.BLOCK_ID.SIGNATURE_BLOCK, 0);
  sigTlvHdr.writeUInt32LE(sigPayload68.length, 4);

  const bodyBeforeSig = Buffer.concat(tlvChunks);
  const fullSigBlock = Buffer.concat([sigTlvHdr, sigPayload68]);
  const header8 = Buffer.alloc(8);
  header8.writeUInt32LE(0x00000014, 0); // Server-issued SPLicense magic (20)
  header8.writeUInt32LE(
    options.headerCoversSignatureBlock
      ? bodyBeforeSig.length + fullSigBlock.length
      : bodyBeforeSig.length,
    4
  );

  return Buffer.concat([header8, bodyBeforeSig, fullSigBlock]);
}

function buildW3cSignedLicenseXml(spLicenseBlockB64: string): string {
  // Include >550 chars of preamble before `<SPLicenseBlock>` so `<SPLicenseBlock>` sits past offset ~600
  // (matching live `licensing.mp.microsoft.com/v8.0/licenses/content` where `<SPLicenseBlock>` is at ~978)
  const longPreamble =
    `<LicenseHeader>` +
    `<IssueDate>2026-10-28T00:00:00Z</IssueDate>` +
    `<LicenseInstanceId>77889900-aabb-ccdd-eeff-001122334455</LicenseInstanceId>` +
    `<BindingMetadata>` +
    'SyntheticStoreLicenseBindingMetadataPreamblePadding'.repeat(10) +
    `</BindingMetadata>` +
    `</LicenseHeader>`;

  const canonicalLicensePrefix =
    `<License xmlns="http://schemas.microsoft.com/2003/08/dicat" Version="1">` +
    longPreamble +
    `<LicenseData><SPLicenseBlock>${spLicenseBlockB64}</SPLicenseBlock></LicenseData>`;
  const canonicalLicenseSuffix = `</License>`;
  const canonicalLicenseWithoutSignature = canonicalLicensePrefix + canonicalLicenseSuffix;

  const digestB64 = crypto
    .createHash('sha256')
    .update(canonicalLicenseWithoutSignature, 'utf8')
    .digest('base64');

  const canonicalSignedInfo =
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></SignatureMethod>` +
    `<Reference URI="">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></DigestMethod>` +
    `<DigestValue>${digestB64}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`;

  const signatureB64 = crypto
    .sign('RSA-SHA256', Buffer.from(canonicalSignedInfo, 'utf8'), sharedRsaPrivateKeyPem)
    .toString('base64');

  // Emit self-closing `<CanonicalizationMethod .../>` & `<Transform .../>` in wire XML to prove
  // `verifyLicenseXmlDsigIfPresent` expands empty tags via true W3C C14N before verifying RSA-SHA256!
  const wireSignedInfo =
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>` +
    `<Reference URI="">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<DigestValue>${digestB64}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`;

  const signatureXml =
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    wireSignedInfo +
    `<SignatureValue>${signatureB64}</SignatureValue>` +
    `<KeyInfo><KeyValue><RSAKeyValue>` +
    `<Modulus>${sharedRsaModulusB64}</Modulus>` +
    `<Exponent>${sharedRsaExponentB64}</Exponent>` +
    `</RSAKeyValue></KeyValue></KeyInfo>` +
    `</Signature>`;

  return canonicalLicensePrefix + signatureXml + canonicalLicenseSuffix;
}

// ============================================================================
// Synthetic `SegmentMetadata.bin`-less Encrypted NTFS `$MFT` XVD Builder
// ============================================================================

function encodeDataRunsBytes(runs: Array<{ clusterCount: number; lcn: number }>): Buffer {
  const bytes: number[] = [];
  let prevLcn = 0;
  for (const run of runs) {
    const delta = run.lcn - prevLcn;
    prevLcn = run.lcn;
    // Use 1-byte clusterCount (1..127) and 1-byte signed delta (-128..127) -> headerByte = 0x11
    bytes.push(0x11, run.clusterCount & 0xff, delta & 0xff);
  }
  bytes.push(0x00);
  const raw = Buffer.from(bytes);
  const paddedLen = Math.ceil(raw.length / 8) * 8;
  const out = Buffer.alloc(paddedLen, 0);
  raw.copy(out, 0);
  return out;
}

function buildNtfsMftRecord1024(spec: {
  isDirectory?: boolean;
  parentRecordNumber?: number;
  fileName?: string;
  residentData?: Buffer;
  nonResidentData?: { fileSize: number; runs: Array<{ clusterCount: number; lcn: number }> };
}): Buffer {
  const rec = Buffer.alloc(1024, 0);
  rec.write('FILE', 0x00, 'ascii');
  const usaOffset = 0x30;
  const usaCount = 3; // USN + 2 sector fixup words (for 1024B = 2 * 512B sectors)
  rec.writeUInt16LE(usaOffset, 0x04);
  rec.writeUInt16LE(usaCount, 0x06);
  const firstAttrOffset = 0x38; // 8-byte aligned after 0x30 + 6 bytes
  rec.writeUInt16LE(firstAttrOffset, 0x14);
  rec.writeUInt16LE(spec.isDirectory ? 0x0003 : 0x0001, 0x16);

  let cursor = firstAttrOffset;

  if (spec.fileName !== undefined && spec.parentRecordNumber !== undefined) {
    const fnUtf16 = Buffer.from(spec.fileName, 'utf16le');
    const valLen = 66 + fnUtf16.length;
    const valOff = 24;
    const attrLen = Math.ceil((valOff + valLen) / 8) * 8;
    rec.writeUInt32LE(0x30, cursor + 0); // $FILE_NAME
    rec.writeUInt32LE(attrLen, cursor + 4);
    rec.writeUInt8(0, cursor + 8); // resident
    rec.writeUInt32LE(valLen, cursor + 16);
    rec.writeUInt16LE(valOff, cursor + 20);

    const vStart = cursor + valOff;
    rec.writeUInt32LE(spec.parentRecordNumber >>> 0, vStart + 0);
    rec.writeUInt16LE(0, vStart + 4);
    rec.writeUInt16LE(1, vStart + 6); // sequence number
    rec.writeUInt8(spec.fileName.length, vStart + 64);
    rec.writeUInt8(1, vStart + 65); // Win32 namespace
    fnUtf16.copy(rec, vStart + 66);
    cursor += attrLen;
  }

  if (spec.residentData) {
    const valLen = spec.residentData.length;
    const valOff = 24;
    const attrLen = Math.ceil((valOff + valLen) / 8) * 8;
    rec.writeUInt32LE(0x80, cursor + 0); // $DATA
    rec.writeUInt32LE(attrLen, cursor + 4);
    rec.writeUInt8(0, cursor + 8); // resident
    rec.writeUInt8(0, cursor + 9); // unnamed
    rec.writeUInt32LE(valLen, cursor + 16);
    rec.writeUInt16LE(valOff, cursor + 20);
    spec.residentData.copy(rec, cursor + valOff);
    cursor += attrLen;
  } else if (spec.nonResidentData) {
    const runBytes = encodeDataRunsBytes(spec.nonResidentData.runs);
    const runOff = 64;
    const attrLen = Math.ceil((runOff + runBytes.length) / 8) * 8;
    const totalClusters = spec.nonResidentData.runs.reduce((acc, r) => acc + r.clusterCount, 0);
    const allocBytes = totalClusters * 4096;

    rec.writeUInt32LE(0x80, cursor + 0); // $DATA
    rec.writeUInt32LE(attrLen, cursor + 4);
    rec.writeUInt8(1, cursor + 8); // non-resident
    rec.writeUInt8(0, cursor + 9); // unnamed
    rec.writeBigUInt64LE(0n, cursor + 16); // lowest VCN
    rec.writeBigUInt64LE(BigInt(Math.max(0, totalClusters - 1)), cursor + 24); // highest VCN
    rec.writeUInt16LE(runOff, cursor + 32);
    rec.writeBigUInt64LE(BigInt(allocBytes), cursor + 40);
    rec.writeBigUInt64LE(BigInt(spec.nonResidentData.fileSize), cursor + 48);
    rec.writeBigUInt64LE(BigInt(spec.nonResidentData.fileSize), cursor + 56);
    runBytes.copy(rec, cursor + runOff);
    cursor += attrLen;
  }

  // End-of-attributes marker
  rec.writeUInt32LE(0xffffffff, cursor);
  rec.writeUInt32LE(cursor + 8, 0x18);
  rec.writeUInt32LE(1024, 0x1c);

  // Populate multi-sector Update Sequence Array (USN = 0x55aa) at 0x1fe and 0x3fe
  const usn = 0x55aa;
  rec.writeUInt16LE(usn, usaOffset + 0);
  rec.writeUInt16LE(rec.readUInt16LE(0x1fe), usaOffset + 2);
  rec.writeUInt16LE(rec.readUInt16LE(0x3fe), usaOffset + 4);
  rec.writeUInt16LE(usn, 0x1fe);
  rec.writeUInt16LE(usn, 0x3fe);

  return rec;
}

function buildSyntheticEncryptedNtfsOnlyXvd(options: {
  cik32: Buffer;
  keyGuid: string;
  vduidGuid?: string;
  contentIdGuid?: string;
}) {
  const vduidGuid = options.vduidGuid || '22334455-6677-8899-aabb-ccddeeff0011';
  const contentIdGuid = options.contentIdGuid || '99887766-5544-3322-1100-ffeeddccbbaa';
  const clusterSize = 4096;
  const totalClusters = 20; // 80 KiB virtual NTFS volume: LCN 0..7 plaintext, LCN 8..19 encrypted XVC Region 1
  const driveSize = totalClusters * clusterSize;

  const gameConfigXmlBuf = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<Game configVersion="1">` +
      `<Identity Name="Publisher.NtfsOnlyGame" Publisher="CN=Synthetic" Version="1.2.0.0"/>` +
      `<ExecutableList><Executable Name="Game.exe" Id="Game"/></ExecutableList>` +
      `</Game>`,
    'utf8'
  );
  const readmeBuf = Buffer.from('Plaintext NTFS bootstrap note outside encrypted XVC region.\n', 'utf8');

  // 1) Contiguous 0x1000-aligned encrypted executable (2 clusters = 8192B allocated, 5620B logical)
  const gameExePlain = Buffer.alloc(5620, 0x41);
  buildValidMinimalPe64Buffer('NTFS-ENCRYPTED-SINGLE-RUN-EXE').copy(gameExePlain, 0);

  // 2) Multi-run fragmented encrypted asset (Run 1: LCN 10 [1 cluster], Run 2: LCN 13 [2 clusters], 9450B logical)
  const fragmentedPakPlain = Buffer.alloc(9450);
  for (let i = 0; i < fragmentedPakPlain.length; i += 1) {
    fragmentedPakPlain[i] = (i * 37 + 19) & 0xff;
  }

  // UserData intentionally contains ZERO `SegmentMetadata.bin` entries!
  const userDataBuf = buildSyntheticUserData(
    'Publisher.NtfsOnlyGame_1.2.0.0_x64__8wekyb3d8bbwe',
    []
  );
  const xvcDataLength =
    msixvcXvdParser.XVC_INFO_HEADER_SIZE + msixvcXvdParser.XVC_REGION_HEADER_SIZE;

  const hdr = Buffer.alloc(msixvcXvdParser.XVD_HEADER_SECTION_SIZE, 0);
  hdr.write('msft-xvd', 0x200, 'ascii');
  const volFlags =
    msixvcXvdParser.XVD_VOLUME_FLAGS.READ_ONLY | msixvcXvdParser.XVD_VOLUME_FLAGS.REGION_ID_IN_XTS;
  hdr.writeUInt32LE(volFlags, 0x208);
  hdr.writeUInt32LE(3, 0x20c);
  hdr.writeBigUInt64LE(BigInt(driveSize), 0x218);
  msixvcXvdParser.writeGuidLE(vduidGuid, hdr, 0x220);
  // Non-zero `topHashBlockHash` at 0x240..0x260 activates strict L0 SHA-256 page verification
  crypto.createHash('sha256').update('synthetic-top-hash-block').digest().copy(hdr, 0x240);
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

  // Encrypted XVC Region 1 covers LCN 8..19 (leaving VBR at LCN 0 and $MFT at LCN 1..4 in plaintext)
  const encryptedStartVirtOff = 8 * clusterSize;
  const encryptedRegionByteOff = layout.driveData.byteOffset + encryptedStartVirtOff;
  const encryptedRegionByteLen = driveSize - encryptedStartVirtOff;

  const xvcBuf = Buffer.alloc(xvcDataLength, 0);
  msixvcXvdParser.writeGuidLE(contentIdGuid, xvcBuf, 0x000);
  msixvcXvdParser.writeGuidLE(options.keyGuid, xvcBuf, 0x010);
  xvcBuf.writeUInt32LE(1, 0xd10); // version
  xvcBuf.writeUInt32LE(1, 0xd14); // regionCount = 1
  xvcBuf.writeUInt16LE(1, 0xd1e); // keyCount = 1

  const rOff = msixvcXvdParser.XVC_INFO_HEADER_SIZE;
  xvcBuf.writeUInt32LE(1, rOff + 0x00); // regionId = 1
  xvcBuf.writeUInt16LE(0, rOff + 0x04); // keyId = 0 -> options.keyGuid
  Buffer.from('EncryptedNtfsPayload\0', 'utf16le').copy(xvcBuf, rOff + 0x10);
  xvcBuf.writeBigUInt64LE(BigInt(encryptedRegionByteOff), rOff + 0x50);
  xvcBuf.writeBigUInt64LE(BigInt(encryptedRegionByteLen), rOff + 0x58);
  xvcBuf.copy(container, layout.xvcInfo.byteOffset);

  // Build NTFS Volume Boot Record (VBR) at LCN 0
  const driveView = container.subarray(
    layout.driveData.byteOffset,
    layout.driveData.byteOffset + driveSize
  );
  driveView.write('NTFS    ', 0x03, 'ascii');
  driveView.writeUInt16LE(512, 0x0b); // bytesPerSector
  driveView.writeUInt8(8, 0x0d); // sectorsPerCluster (8 * 512 = 4096)
  driveView.writeBigUInt64LE(1n, 0x30); // $MFT starts at LCN 1
  driveView.writeInt8(-10, 0x40); // 1024-byte MFT records (2^10)
  driveView[0x1fe] = 0x55;
  driveView[0x1ff] = 0xaa;

  // Populate $MFT at LCN 1..4 (16 records * 1024B = 16384B = 4 clusters)
  const mftStart = 1 * clusterSize;
  const writeMftRec = (recIdx: number, recBuf: Buffer) => {
    recBuf.copy(driveView, mftStart + recIdx * 1024);
  };

  // Record 0: $MFT itself
  writeMftRec(
    0,
    buildNtfsMftRecord1024({
      parentRecordNumber: 5,
      fileName: '$MFT',
      nonResidentData: { fileSize: 16 * 1024, runs: [{ lcn: 1, clusterCount: 4 }] },
    })
  );
  // Record 5: Root "."
  writeMftRec(5, buildNtfsMftRecord1024({ isDirectory: true, parentRecordNumber: 5, fileName: '.' }));
  // Record 6: "Files"
  writeMftRec(
    6,
    buildNtfsMftRecord1024({ isDirectory: true, parentRecordNumber: 5, fileName: 'Files' })
  );
  // Record 7: "Files/Data"
  writeMftRec(
    7,
    buildNtfsMftRecord1024({ isDirectory: true, parentRecordNumber: 6, fileName: 'Data' })
  );
  // Record 8: "Files/MicrosoftGame.config" (resident)
  writeMftRec(
    8,
    buildNtfsMftRecord1024({
      parentRecordNumber: 6,
      fileName: 'MicrosoftGame.config',
      residentData: gameConfigXmlBuf,
    })
  );
  // Record 9: "Files/readme.txt" (non-resident plaintext at LCN 5)
  readmeBuf.copy(driveView, 5 * clusterSize);
  writeMftRec(
    9,
    buildNtfsMftRecord1024({
      parentRecordNumber: 6,
      fileName: 'readme.txt',
      nonResidentData: { fileSize: readmeBuf.length, runs: [{ lcn: 5, clusterCount: 1 }] },
    })
  );
  // Record 10: "Files/Game.exe" (contiguous encrypted run at LCN 8..9 -> promoted to normalizedSegments)
  gameExePlain.copy(driveView, 8 * clusterSize);
  writeMftRec(
    10,
    buildNtfsMftRecord1024({
      parentRecordNumber: 6,
      fileName: 'Game.exe',
      nonResidentData: { fileSize: gameExePlain.length, runs: [{ lcn: 8, clusterCount: 2 }] },
    })
  );
  // Record 11: "Files/Data/pak0.pak" (fragmented encrypted runs at LCN 10 [1] + LCN 13 [2] -> extraInlineFiles)
  fragmentedPakPlain.copy(driveView, 10 * clusterSize, 0, 4096);
  fragmentedPakPlain.copy(driveView, 13 * clusterSize, 4096, fragmentedPakPlain.length);
  writeMftRec(
    11,
    buildNtfsMftRecord1024({
      parentRecordNumber: 7,
      fileName: 'pak0.pak',
      nonResidentData: {
        fileSize: fragmentedPakPlain.length,
        runs: [
          { lcn: 10, clusterCount: 1 },
          { lcn: 13, clusterCount: 2 },
        ],
      },
    })
  );

  // Encrypt all XVC Region 1 pages (LCN 8..19) and populate authentic L0 HashTree entries + non-sequential dataUnits
  const osslKey = msixvcStreamExtractor.buildOpenSslXtsKey(options.cik32);
  const totalHashedPages = layout.hashTree.totalHashedPages;

  for (let hashedIdx = 0; hashedIdx < totalHashedPages; hashedIdx += 1) {
    const pageByteOff = layout.userData.byteOffset + hashedIdx * msixvcXvdParser.XVD_PAGE_SIZE;
    const dataUnit = 700 + hashedIdx * 5;

    if (
      pageByteOff >= encryptedRegionByteOff &&
      pageByteOff < encryptedRegionByteOff + encryptedRegionByteLen
    ) {
      const plainPage = Buffer.from(
        container.subarray(pageByteOff, pageByteOff + msixvcXvdParser.XVD_PAGE_SIZE)
      );
      const tweak = msixvcStreamExtractor.buildXvdXtsTweak(dataUnit, 1, parsedHeader.vduidLow8);
      const cipherPage = msixvcStreamExtractor.encryptXvdPage(plainPage, osslKey, tweak);
      cipherPage.copy(container, pageByteOff);
    }

    const onDiskPage = container.subarray(pageByteOff, pageByteOff + msixvcXvdParser.XVD_PAGE_SIZE);
    const l0Hash20 = msixvcXvdParser.computeXvdL0PageHash(onDiskPage, 20);
    const l0Page = Math.floor(hashedIdx / msixvcXvdParser.XVD_HASH_ENTRIES_PER_PAGE);
    const entryIdx = hashedIdx % msixvcXvdParser.XVD_HASH_ENTRIES_PER_PAGE;
    const entryByteOff =
      layout.hashTree.level0ByteOffset +
      l0Page * msixvcXvdParser.XVD_PAGE_SIZE +
      entryIdx * msixvcXvdParser.XVD_HASH_ENTRY_SIZE;
    l0Hash20.copy(container, entryByteOff);
    container.writeUInt32LE(dataUnit, entryByteOff + 20);
  }

  return {
    container,
    gameConfigXmlBuf,
    readmeBuf,
    gameExePlain,
    fragmentedPakPlain,
    encryptedGameExePageOffset: layout.driveData.byteOffset + 8 * clusterSize,
    encryptedFragmentedPageOffset: layout.driveData.byteOffset + 13 * clusterSize,
  };
}

// ============================================================================
// Test Suites
// ============================================================================

describe('Wave 3B: Xbox Download Regression, Server-Signed SPLicense (0x00cc + XML-DSig), Encrypted NTFS $MFT & Dual-OS Routing', () => {
  let tmpDir: string;
  let socketGuard: ReturnType<typeof installHermeticOfflineSocketGuard>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-wave3b-'));
    socketGuard = installHermeticOfflineSocketGuard();
  });

  afterEach(() => {
    downloadQueueCoordinator.clearDownloadQueue({ userDataDir: tmpDir });
    socketGuard.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('1. Online Server-Signed <License> XML (0x00cc + W3C XML-DSig RSA-SHA256, zero 0x0101)', () => {
    it('verifies W3C XML-DSig + 0x00cc server-signed <License> XML (both raw XML and Base64-encoded >600B preamble) and unwraps 32-byte CIK', async () => {
      const deviceKey16 = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
      const expectedCik32 = Buffer.from(
        '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
        'hex'
      );
      const keyGuid = 'fedcba98-7654-3210-fedc-ba9876543210';
      const contentId = '99887766-5544-3322-1100-ffeeddccbbaa';

      const spBuf = buildServerSignedSpLicenseBuffer0x00cc({
        deviceKey16,
        licenseIdGuid: '11223344-5566-7788-99aa-bbccddeeff00',
        packageFullName: 'Publisher.SampleGame_1.0.0.0_x64__8wekyb3d8bbwe',
        contentKeys: [{ keyIdGuid: keyGuid, cik32: expectedCik32 }],
      });
      const signedXml = buildW3cSignedLicenseXml(spBuf.toString('base64'));
      expect(signedXml.indexOf('<SPLicenseBlock>')).toBeGreaterThan(500);

      // Direct parser check on raw XML
      const parsedRaw = xboxDeviceClep.parseSpLicenseBase64(signedXml, {
        verifyCmacWithKey: deviceKey16,
      });
      expect(parsedRaw.xmlSignatureVerified).toBe(true);
      expect(parsedRaw.signatureType).toBe('server-0x00cc');
      expect(parsedRaw.serverSignaturePresent).toBe(true);
      expect(parsedRaw.cmacVerified).toBe(false);
      expect(parsedRaw.packedContentKeys).toHaveLength(1);

      // Base64-encoded `<License>` XML payload (exact production shape from `licensing.mp.microsoft.com`)
      const base64EncodedXml = Buffer.from(signedXml, 'utf8').toString('base64');
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            licenses: [{ licenseBlob: base64EncodedXml }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const acquired = await xboxDeviceClep.acquireContentCik({
        contentId,
        msaStoreToken: 't=synthetic_store_msa_ticket&p=',
        deviceContext: {
          deviceKeyBuffer: deviceKey16,
          deviceToken: 't=synthetic_device_ticket',
        },
        fetchImpl: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(acquired.cikBuffer.equals(expectedCik32)).toBe(true);
      expect(acquired.keyId).toBe(keyGuid);
      expect(acquired.cikHex).toBe(expectedCik32.toString('hex'));
    });

    it('rejects 1-byte tampering inside <SPLicenseBlock> or <SignatureValue> with SPLICENSE_SIGNATURE_TAMPERED and aborts acquireContentCik without falling through', async () => {
      const deviceKey16 = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
      const expectedCik32 = crypto.randomBytes(32);
      const spBuf = buildServerSignedSpLicenseBuffer0x00cc({
        deviceKey16,
        contentKeys: [{ keyIdGuid: 'fedcba98-7654-3210-fedc-ba9876543210', cik32: expectedCik32 }],
      });
      const signedXml = buildW3cSignedLicenseXml(spBuf.toString('base64'));

      // Case A: Tamper 1 byte inside `<SPLicenseBlock>` (invalidates SHA-256 `<DigestValue>`)
      const mutatedSpBuf = Buffer.from(spBuf);
      mutatedSpBuf[12] ^= 0xff;
      const tamperedDigestXml = signedXml.replace(
        /<SPLicenseBlock>[\s\S]*?<\/SPLicenseBlock>/,
        `<SPLicenseBlock>${mutatedSpBuf.toString('base64')}</SPLicenseBlock>`
      );

      expect(() =>
        xboxDeviceClep.parseSpLicenseBase64(tamperedDigestXml, { verifyCmacWithKey: deviceKey16 })
      ).toThrowError(expect.objectContaining({ code: 'SPLICENSE_SIGNATURE_TAMPERED' }));

      // Case B: Tamper `<SignatureValue>` (Digest matches, RSA-SHA256 verification fails)
      const tamperedSigXml = signedXml.replace(
        /<SignatureValue>([\s\S]*?)<\/SignatureValue>/,
        (_full, b64) => {
          const rawSig = Buffer.from(String(b64).trim(), 'base64');
          rawSig[0] ^= 0x01;
          return `<SignatureValue>${rawSig.toString('base64')}</SignatureValue>`;
        }
      );

      let fetchCalls = 0;
      const mockFetch = vi.fn(async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            licenses: [
              { licenseBlob: Buffer.from(tamperedSigXml, 'utf8').toString('base64') },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      await expect(
        xboxDeviceClep.acquireContentCik({
          contentId: '99887766-5544-3322-1100-ffeeddccbbaa',
          satisfyingEntitlementKeys: [{ productId: '9NTESTGP0001', skuId: '0010' }],
          msaStoreToken: 't=synthetic_store_msa_ticket&p=',
          deviceContext: {
            deviceKeyBuffer: deviceKey16,
            deviceToken: 't=synthetic_device_ticket',
          },
          fetchImpl: mockFetch,
        })
      ).rejects.toMatchObject({ code: 'SPLICENSE_SIGNATURE_TAMPERED' });

      // Must abort immediately on Attempt 1 without falling through to Attempt 2!
      expect(fetchCalls).toBe(1);
    });
  });

  describe('2. Game Pass 2-Step acquireContentCik Retry (Attempt 1 Key-less 0x00cc -> Attempt 2 satisfyingEntitlementKeys)', () => {
    it('retries with satisfyingEntitlementKeys when Attempt 1 returns HTTP 200 with a key-less 0x00cc subscription license', async () => {
      const deviceKey16 = Buffer.from('11223344556677889900aabbccddeeff', 'hex');
      const expectedCik32 = Buffer.from(
        'f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff',
        'hex'
      );
      const keyGuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

      // Attempt 1: Valid server-signed 0x00cc `<SPLicenseBlock>` with NO `0x00ca` content keys
      const keylessSpBuf = buildServerSignedSpLicenseBuffer0x00cc({
        licenseIdGuid: '12345678-1234-5678-9abc-def012345678',
        packageFullName: 'Publisher.GamePassTitle_1.0.0.0_x64__8wekyb3d8bbwe',
        contentKeys: [],
      });
      const keylessSignedXmlB64 = Buffer.from(
        buildW3cSignedLicenseXml(keylessSpBuf.toString('base64')),
        'utf8'
      ).toString('base64');

      // Attempt 2: Valid server-signed 0x00cc `<SPLicenseBlock>` with `0x00ca` wrapped CIK
      const keyedSpBuf = buildServerSignedSpLicenseBuffer0x00cc({
        deviceKey16,
        licenseIdGuid: '12345678-1234-5678-9abc-def012345678',
        packageFullName: 'Publisher.GamePassTitle_1.0.0.0_x64__8wekyb3d8bbwe',
        contentKeys: [{ keyIdGuid: keyGuid, cik32: expectedCik32 }],
      });
      const keyedSignedXmlB64 = Buffer.from(
        buildW3cSignedLicenseXml(keyedSpBuf.toString('base64')),
        'utf8'
      ).toString('base64');

      const requestBodies: any[] = [];
      const mockFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const parsedBody = JSON.parse(String(init?.body || '{}'));
        requestBodies.push(parsedBody);
        const blob = requestBodies.length === 1 ? keylessSignedXmlB64 : keyedSignedXmlB64;
        return new Response(JSON.stringify({ licenses: [{ licenseBlob: blob }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const result = await xboxDeviceClep.acquireContentCik({
        contentId: '99887766-5544-3322-1100-ffeeddccbbaa',
        satisfyingEntitlementKeys: [{ productId: '9NGAMEPASS01', skuId: '0010' }],
        msaStoreToken: 't=synthetic_store_msa_ticket&p=',
        deviceContext: {
          deviceKeyBuffer: deviceKey16,
          deviceToken: 't=synthetic_device_ticket',
        },
        fetchImpl: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(requestBodies[0].satisfyingEntitlementKeys).toBeUndefined();
      expect(requestBodies[1].satisfyingEntitlementKeys).toEqual([
        { productId: '9NGAMEPASS01', skuId: '0010' },
      ]);
      expect(result.cikBuffer.equals(expectedCik32)).toBe(true);
      expect(result.keyId).toBe(keyGuid);
    });
  });

  describe('3. Fresh-Machine Device Provisioning (0x00cc signatureOrigin=9) & Local 0x0101 / Unsigned Contracts', () => {
    it('unwraps EncryptedDeviceKey (0x0001) + ClepSignState (0x012d) from a deviceaddcredential.srf 0x00cc (signatureOrigin=9, headerCoversSignatureBlock) blob without 0x0101', () => {
      const expectedDeviceKey16 = Buffer.from('aabbccddeeff00112233445566778899', 'hex');
      const devProvisionSpBuf = buildServerSignedSpLicenseBuffer0x00cc({
        encryptedDeviceKey16: expectedDeviceKey16,
        clepRsaPrivateKeyPem: sharedRsaPrivateKeyPem,
        signatureOrigin: 9,
        headerCoversSignatureBlock: true,
      });

      const srfXml =
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<DeviceAddResponse>` +
        `<Status>0</Status>` +
        `<Puid>00037FFEB0001111</Puid>` +
        `<SPLicense>${Buffer.from(
          `<License><SPLicenseBlock>${devProvisionSpBuf.toString('base64')}</SPLicenseBlock></License>`,
          'utf8'
        ).toString('base64')}</SPLicense>` +
        `</DeviceAddResponse>`;

      const srfInnerMatch = /<SPLicense>([^<]+)<\/SPLicense>/.exec(srfXml);
      expect(srfInnerMatch).not.toBeNull();

      const parsed = xboxDeviceClep.parseSpLicenseBase64(srfInnerMatch![1]);
      expect(parsed.signatureType).toBe('server-0x00cc');
      expect(parsed.serverSignaturePresent).toBe(true);
      expect(parsed.cmacVerified).toBe(false);
      expect(parsed.signatureBlock?.algorithmId).toBe(1);
      expect(parsed.signatureBlock?.signatureOrigin).toBe(9);
      expect(parsed.deviceKeyBuffer?.equals(expectedDeviceKey16)).toBe(true);
      expect(parsed.clepRsaKeyPem).toContain('BEGIN PRIVATE KEY');
    });

    it('preserves strict AES-128-CMAC (0x0101) verification, rejects tampered 0x0101, and rejects unsigned blobs with SPLICENSE_UNSIGNED', () => {
      const deviceKey16 = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
      const licenseIdRaw = xboxDeviceClep.encodeMixedEndianGuid(
        '11111111-2222-3333-4444-555555555555'
      );
      const tlvHdr = Buffer.alloc(8);
      tlvHdr.writeUInt32LE(xboxDeviceClep.BLOCK_ID.LICENSE_ID, 0);
      tlvHdr.writeUInt32LE(licenseIdRaw.length, 4);
      const spHdr = Buffer.alloc(8);
      spHdr.writeUInt32LE(1, 0);
      spHdr.writeUInt32LE(8, 4);

      const unsignedSlice = Buffer.concat([spHdr, tlvHdr, licenseIdRaw]);

      // Unsigned blob (neither 0x0101 nor 0x00cc) must fail closed with SPLICENSE_UNSIGNED
      expect(() =>
        xboxDeviceClep.parseSpLicenseBuffer(unsignedSlice, { verifyCmacWithKey: deviceKey16 })
      ).toThrowError(
        expect.objectContaining({
          code: 'SPLICENSE_UNSIGNED',
          message:
            'SPLicense missing required signature tag (expected 0x0101 AES-CMAC or 0x00cc SIGNATURE_BLOCK)',
        })
      );

      // Valid 0x0101 AES-128-CMAC passes
      const validCmac16 = xboxDeviceClep.aes128Cmac(deviceKey16, unsignedSlice);
      const cmacHdr = Buffer.alloc(8);
      cmacHdr.writeUInt32LE(xboxDeviceClep.BLOCK_ID.CMAC_SIGNATURE, 0);
      cmacHdr.writeUInt32LE(16, 4);
      const validCmacBuf = Buffer.concat([unsignedSlice, cmacHdr, validCmac16]);

      const parsedCmac = xboxDeviceClep.parseSpLicenseBuffer(validCmacBuf, {
        verifyCmacWithKey: deviceKey16,
      });
      expect(parsedCmac.signatureType).toBe('cmac-0x0101');
      expect(parsedCmac.cmacVerified).toBe(true);

      // 1-bit flip in 0x0101 tag throws SPLICENSE_CMAC_TAMPERED
      const tamperedCmacBuf = Buffer.from(validCmacBuf);
      tamperedCmacBuf[tamperedCmacBuf.length - 1] ^= 0x01;
      expect(() =>
        xboxDeviceClep.parseSpLicenseBuffer(tamperedCmacBuf, { verifyCmacWithKey: deviceKey16 })
      ).toThrowError(expect.objectContaining({ code: 'SPLICENSE_CMAC_TAMPERED' }));
    });
  });

  describe('4. SegmentMetadata.bin-less Encrypted NTFS $MFT XVD Extraction & Pre-Flight / HashTree Guards', () => {
    it('extracts both single-run and multi-run encrypted NTFS $MFT files byte-for-byte when SegmentMetadata.bin is absent', async () => {
      const cik32 = Buffer.from(
        '102132435465768798a9bacbdcedfe0f0f1e2d3c4b5a69788796a5b4c3d2e1f0',
        'hex'
      );
      const keyGuid = 'fedcba98-7654-3210-fedc-ba9876543210';
      const fixture = buildSyntheticEncryptedNtfsOnlyXvd({ cik32, keyGuid });

      const msixvcPath = path.join(tmpDir, 'NtfsOnlyEncrypted.msixvc');
      fs.writeFileSync(msixvcPath, fixture.container);

      const inspection = await msixvcXvdParser.inspectMsixvcContainer({
        msixvcPath,
        includeAllNtfsFiles: true,
        cikMap: { [keyGuid]: cik32 },
      });

      expect(inspection.mappedSegments).toHaveLength(0);
      expect(inspection.ntfsFiles.length).toBeGreaterThanOrEqual(4);
      expect(inspection.gameConfig?.primaryExecutable).toBe('Game.exe');

      // Pre-flight guard: missing CIK must fail closed BEFORE creating installRoot directory or partial files
      const missingCikDir = path.join(tmpDir, 'should-never-exist');
      await expect(
        msixvcStreamExtractor.extractMsixvcStream({
          msixvcPath,
          installDir: missingCikDir,
        })
      ).rejects.toThrow(/Missing Content Integrity Key \(CIK\) for encrypted XVC region/i);
      expect(fs.existsSync(missingCikDir)).toBe(false);

      // Full extraction with valid CIK
      const installDir = path.join(tmpDir, 'installed-ntfs-game');
      const result = await msixvcStreamExtractor.extractMsixvcStream({
        msixvcPath,
        installDir,
        cikMap: { [keyGuid]: cik32 },
      });

      expect(result.fileCount).toBe(4);
      expect(fs.readFileSync(path.join(installDir, 'MicrosoftGame.config'))).toEqual(
        fixture.gameConfigXmlBuf
      );
      expect(fs.readFileSync(path.join(installDir, 'readme.txt'))).toEqual(fixture.readmeBuf);
      expect(fs.readFileSync(path.join(installDir, 'Game.exe'))).toEqual(fixture.gameExePlain);
      expect(fs.readFileSync(path.join(installDir, 'Data', 'pak0.pak'))).toEqual(
        fixture.fragmentedPakPlain
      );
    });

    it('rejects corrupted L0 ciphertext pages on both coalesced single-run and multi-run NTFS streams', async () => {
      const cik32 = Buffer.from(
        '102132435465768798a9bacbdcedfe0f0f1e2d3c4b5a69788796a5b4c3d2e1f0',
        'hex'
      );
      const keyGuid = 'fedcba98-7654-3210-fedc-ba9876543210';
      const fixture = buildSyntheticEncryptedNtfsOnlyXvd({ cik32, keyGuid });

      const corruptedContainer = Buffer.from(fixture.container);
      // Corrupt 1 byte inside the fragmented multi-run encrypted NTFS asset (`Data/pak0.pak`)
      corruptedContainer[fixture.encryptedFragmentedPageOffset + 64] ^= 0x80;

      const corruptedMsixvcPath = path.join(tmpDir, 'CorruptedNtfsOnly.msixvc');
      fs.writeFileSync(corruptedMsixvcPath, corruptedContainer);

      const corruptedInstallDir = path.join(tmpDir, 'corrupted-install');
      await expect(
        msixvcStreamExtractor.extractMsixvcStream({
          msixvcPath: corruptedMsixvcPath,
          installDir: corruptedInstallDir,
          cikMap: { [keyGuid]: cik32 },
        })
      ).rejects.toThrow(/XVD HashTree L0 SHA-256 page integrity check failed/);
    });
  });

  describe('5. Path-Traversal / Win32 Reserved Name Guards & Chunked HTTP 200 Stream Cap', () => {
    it('normalizes valid container paths while rejecting traversal, drive letters, Win32 device names, forbidden chars, and trailing dots/spaces', () => {
      expect(
        msixvcStreamExtractor.normalizeRelativeInstallPath('Files\\\\Subdir//pak0.pak')
      ).toBe('Subdir/pak0.pak');

      for (const badPath of [
        'Files/../secret.dll',
        'C:\\Windows\\win.ini',
        'Files/CON.txt',
        'Files/Sub/NUL',
        'Files/LPT1.bin',
        'Files/foo:bar.dat',
        'Files/trailing.',
        'Files/trailing ',
      ]) {
        expect(() => msixvcStreamExtractor.normalizeRelativeInstallPath(badPath)).toThrow();
      }
    });

    it('streams bounded chunked HTTP 200 OK Range responses without Content-Length and aborts immediately when maxHttp200Bytes is exceeded', async () => {
      const payload = Buffer.from('0123456789ABCDEF-CHUNKED-RANGE-STREAM', 'utf8');

      const okFetch = vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(payload.subarray(0, 10));
            controller.enqueue(payload.subarray(10));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      });

      const sliced = await msixvcXvdParser.fetchRange(
        'http://assets1.xboxlive.com/pkg/test.msixvc',
        4,
        15,
        { fetchImpl: okFetch, maxHttp200Bytes: 1024 }
      );
      expect(sliced.status).toBe(200);
      expect(sliced.buffer.toString('utf8')).toBe('456789ABCDEF');

      // Oversized chunked HTTP 200 without Content-Length must cancel reader and throw immediately
      let readerCancelled = false;
      const oversizedFetch = vi.fn(async () => {
        const bigChunk = Buffer.alloc(512, 0x61);
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(bigChunk);
            if (pulls >= 10) controller.close();
          },
          cancel() {
            readerCancelled = true;
          },
        });
        return new Response(stream, { status: 200 });
      });

      await expect(
        msixvcXvdParser.fetchRange('http://assets1.xboxlive.com/pkg/huge.msixvc', 0, 15, {
          fetchImpl: oversizedFetch,
          maxHttp200Bytes: 1024,
          retries: 0,
        })
      ).rejects.toThrow(/Aborted oversized chunked HTTP 200 response/);
      expect(readerCancelled).toBe(true);
    });
  });

  describe('6. Dual-OS Routing (Windows GamingServices vs Clientless, macOS External Handoff) & SQLite V2 neutral Metadata Merge', () => {
    it('detects Windows GamingServices markers across drivers, AppX Packages, and secondary XboxGames roots while preserving hermetic homedir isolation', () => {
      const emptyHome = path.join(tmpDir, 'empty-win-home');
      const fakeSystemRoot = path.join(tmpDir, 'FakeWindows');
      const fakeProgramFiles = path.join(tmpDir, 'FakeProgramFiles');
      fs.mkdirSync(emptyHome, { recursive: true });
      fs.mkdirSync(fakeSystemRoot, { recursive: true });
      fs.mkdirSync(fakeProgramFiles, { recursive: true });

      // Isolated homedir with no GamingServices markers -> must return false without probing host drives/registry
      expect(
        diskAndVolumeInspector.hasWindowsGamingServicesInstalled({
          platform: 'win32',
          homedir: emptyHome,
          systemRoot: fakeSystemRoot,
          localAppData: path.join(emptyHome, 'AppData', 'Local'),
          mountedDriveRoots: [],
        })
      ).toBe(false);

      // Marker 1: `<SystemRoot>/System32/drivers/gameflt.sys`
      const driversDir = path.join(fakeSystemRoot, 'System32', 'drivers');
      fs.mkdirSync(driversDir, { recursive: true });
      const gamefltPath = path.join(driversDir, 'gameflt.sys');
      fs.writeFileSync(gamefltPath, 'MZ');
      expect(
        diskAndVolumeInspector.hasWindowsGamingServicesInstalled({
          platform: 'win32',
          homedir: emptyHome,
          systemRoot: fakeSystemRoot,
          mountedDriveRoots: [],
        })
      ).toBe(true);
      fs.rmSync(gamefltPath, { force: true });

      // Marker 2: `%LOCALAPPDATA%/Packages/Microsoft.GamingServices_8wekyb3d8bbwe`
      const gsPkgDir = path.join(
        emptyHome,
        'AppData',
        'Local',
        'Packages',
        'Microsoft.GamingServices_8wekyb3d8bbwe'
      );
      fs.mkdirSync(gsPkgDir, { recursive: true });
      expect(
        diskAndVolumeInspector.hasWindowsGamingServicesInstalled({
          platform: 'win32',
          homedir: emptyHome,
          systemRoot: fakeSystemRoot,
          localAppData: path.join(emptyHome, 'AppData', 'Local'),
          mountedDriveRoots: [],
        })
      ).toBe(true);
      fs.rmSync(gsPkgDir, { recursive: true, force: true });

      // Marker 3: Secondary mounted drive `D:/XboxGames`
      const fakeDriveD = path.join(tmpDir, 'DriveD');
      fs.mkdirSync(path.join(fakeDriveD, 'XboxGames'), { recursive: true });
      expect(
        diskAndVolumeInspector.hasWindowsGamingServicesInstalled({
          platform: 'win32',
          homedir: emptyHome,
          systemRoot: fakeSystemRoot,
          mountedDriveRoots: [fakeDriveD],
        })
      ).toBe(true);
    });

    it('honors explicit Windows GamingServices selection (`msxbox://` / `ms-windows-store://`) and falls back to clientless MSIXVC when omitted without GamingServices', async () => {
      const openedUris: string[] = [];
      const winHome = path.join(tmpDir, 'win-routing-home');
      fs.mkdirSync(winHome, { recursive: true });

      // 1) Explicit `installerId: 'xbox-win-gamingservices'` with `preferClientlessExtraction: false`
      //    must open `ms-windows-store://` (or `msxbox://`) even when `hasGamingServices: false`!
      const gsRes = await downloadQueueCoordinator.installGame(
        {
          gameId: 'xbox:9NWINROUTE01',
          title: 'Synthetic Windows Route Title',
          platformId: 'xbox',
          platformGameId: '9NWINROUTE01',
          xboxProductId: '9NWINROUTE01',
          installerId: 'xbox-win-gamingservices',
          preferClientlessExtraction: false,
          installDir: path.join(tmpDir, 'win-gs-target'),
        },
        {
          platform: 'win32',
          hasGamingServices: false,
          homedir: winHome,
          userDataDir: tmpDir,
          skipNetwork: true,
          disableXboxMonitor: true,
          onOpenExternal: async (uri: string) => {
            openedUris.push(uri);
          },
        }
      );

      expect(gsRes.success).toBe(true);
      expect(openedUris).toHaveLength(1);
      expect(openedUris[0]).toMatch(/^(msxbox:\/\/game\/\?productId=9NWINROUTE01|ms-windows-store:\/\/pdp\/\?ProductId=9NWINROUTE01)$/);

      // 2) Omitting explicit preference when `hasGamingServices: false` auto-selects clientless MSIXVC
      openedUris.length = 0;
      let resolverInvoked = false;
      const clientlessRes = await downloadQueueCoordinator.installGame(
        {
          gameId: 'xbox:9NWINCLIENT02',
          title: 'Synthetic Clientless Fallback',
          platformId: 'xbox',
          platformGameId: '9NWINCLIENT02',
          xboxProductId: '9NWINCLIENT02',
          installDir: path.join(tmpDir, 'win-clientless-target'),
        },
        {
          platform: 'win32',
          hasGamingServices: false,
          homedir: winHome,
          userDataDir: tmpDir,
          skipNetwork: true,
          disableXboxMonitor: true,
          xboxPackageDeliveryResolver: async () => {
            resolverInvoked = true;
            return { downloadUrls: [] };
          },
          onOpenExternal: async (uri: string) => {
            openedUris.push(uri);
          },
        }
      );

      expect(clientlessRes.success).toBe(true);
      await new Promise((r) => setTimeout(r, 25));
      expect(openedUris).toHaveLength(0);
      expect(resolverInvoked).toBe(true);
    });

    it('opens allowlisted HTTPS publisher handoffs on macOS, rejects untrusted externalLauncherUrl values, and merges neutral LocalizedProperties[1] artwork/descriptions', async () => {
      // Strict HTTPS allowlist validator checks
      expect(
        downloadQueueCoordinator.validateTrustedExternalLauncherUrl('https://www.ea.com/ea-app')
      ).toBe('https://www.ea.com/ea-app');
      expect(
        downloadQueueCoordinator.validateTrustedExternalLauncherUrl(
          'https://www.minecraft.net/en-us/download'
        )
      ).toBe('https://www.minecraft.net/en-us/download');
      expect(
        downloadQueueCoordinator.validateTrustedExternalLauncherUrl('http://www.ea.com/ea-app')
      ).toBe('');
      expect(
        downloadQueueCoordinator.validateTrustedExternalLauncherUrl('https://evil.example.com/ea.dmg')
      ).toBe('');
      expect(
        downloadQueueCoordinator.validateTrustedExternalLauncherUrl(
          'https://user:pass@www.ea.com/ea-app'
        )
      ).toBe('');
      expect(
        downloadQueueCoordinator.validateTrustedExternalLauncherUrl('https://www.ea.com:8443/ea-app')
      ).toBe('');

      const openedMacUris: string[] = [];
      const handoffRes = await downloadQueueCoordinator.installGame(
        {
          gameId: 'xbox:9NEAHANDOFF01',
          title: 'Synthetic EA Play Title',
          platformId: 'xbox',
          platformGameId: '9NEAHANDOFF01',
          xboxProductId: '9NEAHANDOFF01',
          installerId: 'xbox-external-mac-launcher',
          externalLauncher: 'EA app',
          externalLauncherUrl: 'https://www.ea.com/ea-app',
          installDir: path.join(tmpDir, 'mac-handoff'),
        },
        {
          platform: 'darwin',
          userDataDir: tmpDir,
          skipNetwork: true,
          onOpenExternal: async (uri: string) => {
            openedMacUris.push(uri);
          },
        }
      );

      expect(handoffRes.success).toBe(true);
      expect(handoffRes.status).toBe('external_handoff');
      expect(handoffRes.externalUri).toBe('https://www.ea.com/ea-app');
      expect(openedMacUris).toEqual(['https://www.ea.com/ea-app']);

      // Untrusted externalLauncherUrl on macOS `xbox-external-mac-launcher` must fail closed without opening anything
      openedMacUris.length = 0;
      const untrustedRes = await downloadQueueCoordinator.installGame(
        {
          gameId: 'xbox:9NEVILURL001',
          title: 'Untrusted Redirect Attempt',
          platformId: 'xbox',
          platformGameId: '9NEVILURL001',
          xboxProductId: '9NEVILURL001',
          installerId: 'xbox-external-mac-launcher',
          externalLauncher: 'EA app',
          externalLauncherUrl: 'https://attacker.invalid/payload.pkg',
          installDir: path.join(tmpDir, 'mac-evil'),
        },
        {
          platform: 'darwin',
          userDataDir: tmpDir,
          skipNetwork: true,
          onOpenExternal: async (uri: string) => {
            openedMacUris.push(uri);
          },
        }
      );
      expect(untrustedRes.success).toBe(false);
      expect(openedMacUris).toHaveLength(0);

      // SQLite V2 `projectCompactDisplayCatalogProduct` neutral `LocalizedProperties[1]` merge
      const baseProd = buildDisplayCatalogGameFixture({
        productId: '9NNEUTRALART1',
        title: 'Neutral Artwork Merge Title',
      });
      const neutralImages = baseProd.LocalizedProperties[0].Images;
      const splitLocalizedProd = {
        ...baseProd,
        LocalizedProperties: [
          {
            Language: 'en-US',
            ProductTitle: 'Neutral Artwork Merge Title',
            ShortDescription: '',
            ProductDescription: '',
            DeveloperName: '',
            PublisherName: '',
            Images: [],
          },
          {
            Language: 'neutral',
            ProductTitle: '',
            ShortDescription: 'Rich neutral fallback description preserved in SQLite V2.',
            ProductDescription: 'Detailed neutral product description.',
            DeveloperName: 'Neutral Studio',
            PublisherName: 'Neutral Publisher',
            Images: neutralImages,
          },
        ],
      };

      const projected = xboxCatalogAndGamePass.projectCompactDisplayCatalogProduct(splitLocalizedProd);
      expect(projected.LocalizedProperties).toHaveLength(1);
      expect(projected.LocalizedProperties[0].ProductTitle).toBe('Neutral Artwork Merge Title');
      expect(projected.LocalizedProperties[0].ShortDescription).toBe(
        'Rich neutral fallback description preserved in SQLite V2.'
      );
      expect(projected.LocalizedProperties[0].DeveloperName).toBe('Neutral Studio');
      expect(projected.LocalizedProperties[0].Images).toHaveLength(2);
    });
  });
});
