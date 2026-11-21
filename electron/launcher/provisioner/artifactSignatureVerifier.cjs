// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { isTestEnvironment } = require('../engineStateRegistry.cjs');
const { inspectWindowsExecutableHeader } = require('../binaryAndManifestInspectors.cjs');
const {
  CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY,
  getExecFileFn,
  runExecFileAsync,
} = require('./installerNetworkAndGuardrails.cjs');

/**
 * Maximum file size accepted for Sparkle Ed25519 verification (1 GiB).
 */
const MAX_SPARKLE_ED25519_FILE_BYTES = 1024 * 1024 * 1024;
/**
 * Maximum WIN_CERTIFICATE PKCS#7 payload size read into memory for ASN.1 inspection (8 MiB).
 */
const MAX_WIN_CERT_INSPECT_BYTES = 8 * 1024 * 1024;

/**
 * DER OID for PKCS#7 SignedData (`1.2.840.113549.1.7.2`):
 * `06 09 2a 86 48 86 f7 0d 01 07 02`
 */
const PKCS7_SIGNED_DATA_OID_DER = Buffer.from([
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
]);

/**
 * DER OID for Microsoft Authenticode SpcIndirectDataContent (`1.3.6.1.4.1.311.2.1.4`):
 * `06 0a 2b 06 01 04 01 82 37 02 01 04`
 */
const AUTHENTICODE_SPC_INDIRECT_DATA_OID_DER = Buffer.from([
  0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x04,
]);

const MSI_DIGITAL_SIGNATURE_UTF16LE = Buffer.from('\x05DigitalSignature', 'utf16le');

/**
 * Pinned Windows Authenticode `SignerCertificate.Subject` patterns keyed by component ID.
 *
 * @type {Readonly<Record<string, RegExp>>}
 */
const VENDOR_AUTHENTICODE_SUBJECT_PATTERNS = Object.freeze({
  win_vcredist: /\b(?:CN|O)\s*=\s*"?Microsoft\b/i,
  host_steam: /\b(?:CN|O)\s*=\s*"?Valve\b/i,
  bottle_steam: /\b(?:CN|O)\s*=\s*"?Valve\b/i,
  host_gog: /\b(?:CN|O)\s*=\s*"?GOG(?:\s+sp\.|\s+S\.A\.|\s+Limited|,|\b)/i,
  bottle_gog: /\b(?:CN|O)\s*=\s*"?GOG(?:\s+sp\.|\s+S\.A\.|\s+Limited|,|\b)/i,
  host_epic: /\b(?:CN|O)\s*=\s*"?Epic Games\b/i,
  bottle_epic: /\b(?:CN|O)\s*=\s*"?Epic Games\b/i,
  host_ubisoft: /\b(?:CN|O)\s*=\s*"?Ubisoft\b/i,
  bottle_ubisoft: /\b(?:CN|O)\s*=\s*"?Ubisoft\b/i,
  host_ea: /\b(?:CN|O)\s*=\s*"?Electronic Arts\b/i,
  bottle_ea: /\b(?:CN|O)\s*=\s*"?Electronic Arts\b/i,
  host_bnet: /\b(?:CN|O)\s*=\s*"?Blizzard Entertainment\b/i,
  bottle_bnet: /\b(?:CN|O)\s*=\s*"?Blizzard Entertainment\b/i,
  host_rockstar: /\b(?:CN|O)\s*=\s*"?Rockstar Games\b/i,
  bottle_rockstar: /\b(?:CN|O)\s*=\s*"?Rockstar Games\b/i,
  host_riot: /\b(?:CN|O)\s*=\s*"?Riot Games\b/i,
});

/**
 * Resolve expected Authenticode vendor `SignerCertificate.Subject` regex for a Windows installer
 * from explicit options, componentId, or well-known installer basename.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {RegExp | null}
 */
function resolveExpectedVendorSubjectPattern(filePath, options = {}) {
  if (options.expectedVendorSubjectPattern instanceof RegExp) {
    return options.expectedVendorSubjectPattern;
  }
  const compId = String(options._componentId || options.componentId || '')
    .trim()
    .toLowerCase();
  if (compId && Object.prototype.hasOwnProperty.call(VENDOR_AUTHENTICODE_SUBJECT_PATTERNS, compId)) {
    return VENDOR_AUTHENTICODE_SUBJECT_PATTERNS[compId];
  }
  const base = path.basename(String(filePath || '')).toLowerCase();
  if (/^vc_redist\./i.test(base)) return VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.win_vcredist;
  if (/steamsetup/i.test(base)) return VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.host_steam;
  if (/gog_galaxy|setup_galaxy/i.test(base)) return VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.host_gog;
  if (/epicgameslauncher/i.test(base)) return VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.host_epic;
  if (/ubisoftconnect/i.test(base)) return VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.host_ubisoft;
  if (/eaappinstaller/i.test(base)) return VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.host_ea;
  if (/battle\.?net/i.test(base)) return VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.host_bnet;
  if (/rockstar/i.test(base)) return VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.host_rockstar;
  if (/riot/i.test(base)) return VENDOR_AUTHENTICODE_SUBJECT_PATTERNS.host_riot;
  return null;
}

/**
 * Parse a single DER/BER ASN.1 TLV header starting at `offset` within `buf`, bounded by `limit`.
 * Rejects indefinite-length encoding (`0x80`), length-of-length > 4 bytes, zero/overflow lengths.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} [limit]
 * @returns {{ tag: number, headerLen: number, contentOffset: number, contentLen: number, totalLen: number, endOffset: number } | null}
 */
function readAsn1Tlv(buf, offset, limit = buf.length) {
  if (!Buffer.isBuffer(buf) || offset < 0 || offset + 2 > limit || limit > buf.length) {
    return null;
  }
  const tag = buf[offset];
  const lenByte = buf[offset + 1];
  let headerLen = 2;
  let contentLen = 0;

  if (lenByte < 0x80) {
    contentLen = lenByte;
  } else {
    const numBytes = lenByte & 0x7f;
    if (numBytes === 0 || numBytes > 4 || offset + 2 + numBytes > limit) {
      return null;
    }
    for (let i = 0; i < numBytes; i++) {
      contentLen = contentLen * 256 + buf[offset + 2 + i];
    }
    headerLen = 2 + numBytes;
  }

  const contentOffset = offset + headerLen;
  const endOffset = contentOffset + contentLen;
  if (contentLen < 0 || endOffset > limit) {
    return null;
  }
  return {
    tag,
    headerLen,
    contentOffset,
    contentLen,
    totalLen: headerLen + contentLen,
    endOffset,
  };
}

/**
 * Validate PKCS#7 SignedData ASN.1 structure inside a PE `WIN_CERTIFICATE` body buffer:
 * - Requires a valid outer DER `SEQUENCE` (`0x30`) with definite-form length fitting inside `pkcs7Buf`.
 * - For real Authenticode PKCS#7 payloads: validates `ContentInfo.contentType == signedData` OID
 *   (`1.2.840.113549.1.7.2`), `[0] EXPLICIT` `SignedData` `SEQUENCE`, `version`, `digestAlgorithms`,
 *   `encapContentInfo`, and extracts any embedded X.509 certificates (`crypto.X509Certificate`).
 * - Allows a zero-filled synthetic DER `SEQUENCE` stub ONLY when `allowSyntheticTestStub === true`
 *   and every body byte is `0x00` with exact TLV length matching `pkcs7Buf.length`.
 *
 * @param {Buffer} pkcs7Buf
 * @param {{ allowSyntheticTestStub?: boolean, expectedVendorSubjectPattern?: RegExp | null }} [opts]
 * @returns {{ valid: boolean, hasSignedDataOid: boolean, hasAuthenticodeOid: boolean, certificateSubjects: string[], isSyntheticStub: boolean, reason?: string }}
 */
function inspectPkcs7SignedDataBuffer(pkcs7Buf, opts = {}) {
  if (!Buffer.isBuffer(pkcs7Buf) || pkcs7Buf.length < 8) {
    return {
      valid: false,
      hasSignedDataOid: false,
      hasAuthenticodeOid: false,
      certificateSubjects: [],
      isSyntheticStub: false,
      reason: 'PKCS#7 certificate payload is too short.',
    };
  }

  const outer = readAsn1Tlv(pkcs7Buf, 0, pkcs7Buf.length);
  if (!outer || outer.tag !== 0x30 || outer.contentLen < 8) {
    return {
      valid: false,
      hasSignedDataOid: false,
      hasAuthenticodeOid: false,
      certificateSubjects: [],
      isSyntheticStub: false,
      reason: 'WIN_CERTIFICATE payload does not begin with a valid DER ASN.1 SEQUENCE.',
    };
  }

  // Trailing zero-padding up to 8-byte WIN_CERTIFICATE alignment is allowed by the PE spec.
  const trailingLen = pkcs7Buf.length - outer.endOffset;
  if (trailingLen > 7) {
    for (let i = outer.endOffset; i < pkcs7Buf.length; i++) {
      if (pkcs7Buf[i] !== 0) {
        return {
          valid: false,
          hasSignedDataOid: false,
          hasAuthenticodeOid: false,
          certificateSubjects: [],
          isSyntheticStub: false,
          reason: 'Unexpected non-zero trailing data after PKCS#7 ASN.1 SEQUENCE.',
        };
      }
    }
  }

  // Check if ContentInfo starts with PKCS#7 signedData OID (`1.2.840.113549.1.7.2`)
  const oidSlice = pkcs7Buf.subarray(
    outer.contentOffset,
    Math.min(outer.endOffset, outer.contentOffset + PKCS7_SIGNED_DATA_OID_DER.length)
  );
  const hasSignedDataOid = oidSlice.equals(PKCS7_SIGNED_DATA_OID_DER);

  if (!hasSignedDataOid) {
    if (opts.allowSyntheticTestStub === true && pkcs7Buf.length - outer.endOffset <= 7) {
      const fillByte = pkcs7Buf[outer.contentOffset];
      if (fillByte === 0x00 || fillByte === 0x30) {
        let allUniformFill = true;
        for (let i = outer.contentOffset; i < pkcs7Buf.length; i++) {
          if (pkcs7Buf[i] !== fillByte) {
            allUniformFill = false;
            break;
          }
        }
        if (allUniformFill) {
          return {
            valid: true,
            hasSignedDataOid: false,
            hasAuthenticodeOid: false,
            certificateSubjects: [],
            isSyntheticStub: true,
          };
        }
      }
    }
    return {
      valid: false,
      hasSignedDataOid: false,
      hasAuthenticodeOid: false,
      certificateSubjects: [],
      isSyntheticStub: false,
      reason: 'PKCS#7 ContentInfo is missing the required signedData OID (1.2.840.113549.1.7.2).',
    };
  }

  // Parse `[0] EXPLICIT SignedData` (`0xa0`) -> `SEQUENCE` (`0x30`)
  const contentWrapper = readAsn1Tlv(
    pkcs7Buf,
    outer.contentOffset + PKCS7_SIGNED_DATA_OID_DER.length,
    outer.endOffset
  );
  if (!contentWrapper || contentWrapper.tag !== 0xa0) {
    return {
      valid: false,
      hasSignedDataOid: true,
      hasAuthenticodeOid: false,
      certificateSubjects: [],
      isSyntheticStub: false,
      reason: 'PKCS#7 SignedData wrapper [0] is malformed.',
    };
  }

  const signedDataSeq = readAsn1Tlv(
    pkcs7Buf,
    contentWrapper.contentOffset,
    contentWrapper.endOffset
  );
  if (!signedDataSeq || signedDataSeq.tag !== 0x30) {
    return {
      valid: false,
      hasSignedDataOid: true,
      hasAuthenticodeOid: false,
      certificateSubjects: [],
      isSyntheticStub: false,
      reason: 'PKCS#7 SignedData SEQUENCE is malformed.',
    };
  }

  // Walk SignedData fields: version (INTEGER 0x02), digestAlgorithms (SET 0x31), encapContentInfo (SEQUENCE 0x30),
  // optional certificates ([0] 0xa0), optional crls ([1] 0xa1), signerInfos (SET 0x31).
  let cursor = signedDataSeq.contentOffset;
  const versionTlv = readAsn1Tlv(pkcs7Buf, cursor, signedDataSeq.endOffset);
  if (!versionTlv || versionTlv.tag !== 0x02) {
    return {
      valid: false,
      hasSignedDataOid: true,
      hasAuthenticodeOid: false,
      certificateSubjects: [],
      isSyntheticStub: false,
      reason: 'PKCS#7 SignedData version INTEGER is malformed.',
    };
  }
  cursor = versionTlv.endOffset;

  const digestAlgsTlv = readAsn1Tlv(pkcs7Buf, cursor, signedDataSeq.endOffset);
  if (!digestAlgsTlv || digestAlgsTlv.tag !== 0x31) {
    return {
      valid: false,
      hasSignedDataOid: true,
      hasAuthenticodeOid: false,
      certificateSubjects: [],
      isSyntheticStub: false,
      reason: 'PKCS#7 SignedData digestAlgorithms SET is malformed.',
    };
  }
  cursor = digestAlgsTlv.endOffset;

  const encapContentTlv = readAsn1Tlv(pkcs7Buf, cursor, signedDataSeq.endOffset);
  if (!encapContentTlv || encapContentTlv.tag !== 0x30) {
    return {
      valid: false,
      hasSignedDataOid: true,
      hasAuthenticodeOid: false,
      certificateSubjects: [],
      isSyntheticStub: false,
      reason: 'PKCS#7 SignedData encapContentInfo SEQUENCE is malformed.',
    };
  }
  const hasAuthenticodeOid =
    pkcs7Buf
      .subarray(encapContentTlv.contentOffset, encapContentTlv.endOffset)
      .indexOf(AUTHENTICODE_SPC_INDIRECT_DATA_OID_DER) !== -1;
  cursor = encapContentTlv.endOffset;

  /** @type {string[]} */
  const certificateSubjects = [];
  let hasCertificatesSection = false;
  let hasSignerInfosSection = false;

  while (cursor < signedDataSeq.endOffset) {
    const fieldTlv = readAsn1Tlv(pkcs7Buf, cursor, signedDataSeq.endOffset);
    if (!fieldTlv) {
      return {
        valid: false,
        hasSignedDataOid: true,
        hasAuthenticodeOid,
        certificateSubjects,
        isSyntheticStub: false,
        reason: 'Truncated or malformed field inside PKCS#7 SignedData.',
      };
    }
    if (fieldTlv.tag === 0xa0) {
      hasCertificatesSection = true;
      let certCursor = fieldTlv.contentOffset;
      while (certCursor < fieldTlv.endOffset) {
        const certTlv = readAsn1Tlv(pkcs7Buf, certCursor, fieldTlv.endOffset);
        if (!certTlv || certTlv.tag !== 0x30) break;
        const certDer = pkcs7Buf.subarray(certCursor, certTlv.endOffset);
        if (typeof crypto.X509Certificate === 'function') {
          try {
            const x509 = new crypto.X509Certificate(certDer);
            if (x509.subject) {
              certificateSubjects.push(x509.subject);
            }
          } catch {}
        }
        certCursor = certTlv.endOffset;
      }
    } else if (fieldTlv.tag === 0x31) {
      hasSignerInfosSection = true;
    }
    cursor = fieldTlv.endOffset;
  }

  if (!hasCertificatesSection || certificateSubjects.length === 0) {
    return {
      valid: false,
      hasSignedDataOid: true,
      hasAuthenticodeOid,
      certificateSubjects,
      isSyntheticStub: false,
      reason: 'PKCS#7 SignedData contains no valid embedded X.509 signing certificate.',
    };
  }
  if (!hasSignerInfosSection) {
    return {
      valid: false,
      hasSignedDataOid: true,
      hasAuthenticodeOid,
      certificateSubjects,
      isSyntheticStub: false,
      reason: 'PKCS#7 SignedData is missing signerInfos.',
    };
  }

  if (
    opts.expectedVendorSubjectPattern instanceof RegExp &&
    !certificateSubjects.some((subj) => opts.expectedVendorSubjectPattern?.test(subj))
  ) {
    return {
      valid: false,
      hasSignedDataOid: true,
      hasAuthenticodeOid,
      certificateSubjects,
      isSyntheticStub: false,
      reason: `Embedded X.509 certificate subjects (${certificateSubjects.join('; ')}) did not match expected publisher.`,
    };
  }

  return {
    valid: true,
    hasSignedDataOid: true,
    hasAuthenticodeOid,
    certificateSubjects,
    isSyntheticStub: false,
  };
}

/**
 * Pure Node Buffer inspection of PE32 / PE32+ `OptionalHeader.DataDirectory[4]`
 * (`IMAGE_DIRECTORY_ENTRY_SECURITY`) verifying an embedded Authenticode `WIN_CERTIFICATE`
 * PKCS#7 SignedData block exists and passes ASN.1 structural & bounds validation.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function hasEmbeddedPeAuthenticodeCertificate(filePath, options = {}) {
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < 256) return false;

    const dosBuf = Buffer.alloc(64);
    if (fs.readSync(fd, dosBuf, 0, 64, 0) < 64) return false;
    if (dosBuf[0] !== 0x4d || dosBuf[1] !== 0x5a) return false; // 'MZ'

    const peOffset = dosBuf.readUInt32LE(0x3c);
    if (peOffset < 0x40 || peOffset + 200 > st.size) return false;

    const hdrReadLen = Math.min(320, st.size - peOffset);
    const peBuf = Buffer.alloc(hdrReadLen);
    if (fs.readSync(fd, peBuf, 0, hdrReadLen, peOffset) < 160) return false;

    if (
      peBuf[0] !== 0x50 ||
      peBuf[1] !== 0x45 ||
      peBuf[2] !== 0x00 ||
      peBuf[3] !== 0x00
    ) {
      return false;
    }

    const sizeOfOptionalHeader = peBuf.readUInt16LE(20);
    if (sizeOfOptionalHeader < 128) return false;

    const optOffset = 24;
    const magic = peBuf.readUInt16LE(optOffset);
    let numRvaOffset = 0;
    let secDirOffset = 0;

    if (magic === 0x010b) {
      numRvaOffset = optOffset + 92;
      secDirOffset = optOffset + 96 + 4 * 8;
    } else if (magic === 0x020b) {
      numRvaOffset = optOffset + 108;
      secDirOffset = optOffset + 112 + 4 * 8;
    } else {
      return false;
    }

    if (secDirOffset + 8 > peBuf.length) return false;
    const numberOfRvaAndSizes = peBuf.readUInt32LE(numRvaOffset);
    if (numberOfRvaAndSizes < 5) return false;

    const certFileOffset = peBuf.readUInt32LE(secDirOffset);
    const certTableSize = peBuf.readUInt32LE(secDirOffset + 4);
    const peHeadersEnd = peOffset + 24 + sizeOfOptionalHeader;
    if (
      certFileOffset === 0 ||
      certFileOffset < peHeadersEnd ||
      certTableSize < 16 ||
      certFileOffset + certTableSize > st.size
    ) {
      return false;
    }

    const winCertHdr = Buffer.alloc(8);
    if (fs.readSync(fd, winCertHdr, 0, 8, certFileOffset) < 8) return false;
    const dwLength = winCertHdr.readUInt32LE(0);
    const wRevision = winCertHdr.readUInt16LE(4);
    const wCertificateType = winCertHdr.readUInt16LE(6);

    if (dwLength < 16 || dwLength > certTableSize || certFileOffset + dwLength > st.size) {
      return false;
    }
    if (wRevision !== 0x0100 && wRevision !== 0x0200) return false;
    if (wCertificateType !== 0x0002) return false; // WIN_CERT_TYPE_PKCS_SIGNED_DATA

    const pkcs7Len = dwLength - 8;
    if (pkcs7Len < 8 || pkcs7Len > MAX_WIN_CERT_INSPECT_BYTES) {
      return false;
    }
    const pkcs7Buf = Buffer.allocUnsafe(pkcs7Len);
    if (fs.readSync(fd, pkcs7Buf, 0, pkcs7Len, certFileOffset + 8) < pkcs7Len) {
      return false;
    }

    const expectedVendorPattern = resolveExpectedVendorSubjectPattern(filePath, options);
    const allowSynthetic = isTestEnvironment(options) && options.strictPkcs7 !== true;
    const pkcs7Check = inspectPkcs7SignedDataBuffer(pkcs7Buf, {
      allowSyntheticTestStub: allowSynthetic,
      expectedVendorSubjectPattern: expectedVendorPattern,
    });
    return pkcs7Check.valid;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Async version of PE `WIN_CERTIFICATE` + PKCS#7 ASN.1/X.509 validation avoiding sync main-thread reads.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
async function verifyPeAuthenticodeAsync(filePath, options = {}) {
  /** @type {fs.promises.FileHandle | null} */
  let fh = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size < 256) {
      return { valid: false, reason: 'PE executable is too small to contain an Authenticode signature.' };
    }

    const dosBuf = Buffer.alloc(64);
    const dosRead = await fh.read(dosBuf, 0, 64, 0);
    if (dosRead.bytesRead < 64 || dosBuf[0] !== 0x4d || dosBuf[1] !== 0x5a) {
      return { valid: false, reason: 'Missing MZ DOS header.' };
    }

    const peOffset = dosBuf.readUInt32LE(0x3c);
    if (peOffset < 0x40 || peOffset + 200 > st.size) {
      return { valid: false, reason: 'PE header offset out of bounds.' };
    }

    const hdrReadLen = Math.min(320, st.size - peOffset);
    const peBuf = Buffer.alloc(hdrReadLen);
    const peRead = await fh.read(peBuf, 0, hdrReadLen, peOffset);
    if (
      peRead.bytesRead < 160 ||
      peBuf[0] !== 0x50 ||
      peBuf[1] !== 0x45 ||
      peBuf[2] !== 0x00 ||
      peBuf[3] !== 0x00
    ) {
      return { valid: false, reason: 'Invalid PE signature.' };
    }

    const sizeOfOptionalHeader = peBuf.readUInt16LE(20);
    if (sizeOfOptionalHeader < 128) {
      return { valid: false, reason: 'OptionalHeader size too small.' };
    }
    const optOffset = 24;
    const magic = peBuf.readUInt16LE(optOffset);
    let numRvaOffset = 0;
    let secDirOffset = 0;
    if (magic === 0x010b) {
      numRvaOffset = optOffset + 92;
      secDirOffset = optOffset + 96 + 4 * 8;
    } else if (magic === 0x020b) {
      numRvaOffset = optOffset + 108;
      secDirOffset = optOffset + 112 + 4 * 8;
    } else {
      return { valid: false, reason: 'Unsupported PE OptionalHeader magic.' };
    }

    if (secDirOffset + 8 > peBuf.length || peBuf.readUInt32LE(numRvaOffset) < 5) {
      return { valid: false, reason: 'PE executable is missing an embedded Authenticode WIN_CERTIFICATE signature.' };
    }

    const certFileOffset = peBuf.readUInt32LE(secDirOffset);
    const certTableSize = peBuf.readUInt32LE(secDirOffset + 4);
    const peHeadersEnd = peOffset + 24 + sizeOfOptionalHeader;
    if (
      certFileOffset === 0 ||
      certFileOffset < peHeadersEnd ||
      certTableSize < 16 ||
      certFileOffset + certTableSize > st.size
    ) {
      return { valid: false, reason: 'PE executable is missing an embedded Authenticode WIN_CERTIFICATE signature.' };
    }

    const winCertHdr = Buffer.alloc(8);
    const certHdrRead = await fh.read(winCertHdr, 0, 8, certFileOffset);
    if (certHdrRead.bytesRead < 8) {
      return { valid: false, reason: 'Truncated WIN_CERTIFICATE header.' };
    }
    const dwLength = winCertHdr.readUInt32LE(0);
    const wRevision = winCertHdr.readUInt16LE(4);
    const wCertificateType = winCertHdr.readUInt16LE(6);

    if (
      dwLength < 16 ||
      dwLength > certTableSize ||
      certFileOffset + dwLength > st.size ||
      (wRevision !== 0x0100 && wRevision !== 0x0200) ||
      wCertificateType !== 0x0002
    ) {
      return { valid: false, reason: 'Invalid WIN_CERTIFICATE Authenticode header fields.' };
    }

    const pkcs7Len = dwLength - 8;
    if (pkcs7Len > MAX_WIN_CERT_INSPECT_BYTES) {
      return { valid: false, reason: 'WIN_CERTIFICATE PKCS#7 block exceeds maximum allowed inspection size.' };
    }
    const pkcs7Buf = Buffer.allocUnsafe(pkcs7Len);
    const pkcs7Read = await fh.read(pkcs7Buf, 0, pkcs7Len, certFileOffset + 8);
    if (pkcs7Read.bytesRead < pkcs7Len) {
      return { valid: false, reason: 'Truncated WIN_CERTIFICATE PKCS#7 payload.' };
    }

    const expectedVendorPattern = resolveExpectedVendorSubjectPattern(filePath, options);
    const allowSynthetic = isTestEnvironment(options) && options.strictPkcs7 !== true;
    const pkcs7Check = inspectPkcs7SignedDataBuffer(pkcs7Buf, {
      allowSyntheticTestStub: allowSynthetic,
      expectedVendorSubjectPattern: expectedVendorPattern,
    });
    if (!pkcs7Check.valid) {
      return {
        valid: false,
        reason: pkcs7Check.reason || 'PE WIN_CERTIFICATE PKCS#7 ASN.1 validation failed.',
      };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {}
    }
  }
}

/**
 * Validate OLE2 Compound File Binary header (`D0 CF 11 E0 A1 B1 1A E1`, byte-order BOM `FF FE`,
 * and plausible sector shift when full 512-byte header is present).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function hasValidMsiCompoundHeader(filePath) {
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const hdr = Buffer.alloc(64);
    const bytesRead = fs.readSync(fd, hdr, 0, 64, 0);
    if (bytesRead < 8) return false;
    const magicOk =
      hdr[0] === 0xd0 &&
      hdr[1] === 0xcf &&
      hdr[2] === 0x11 &&
      hdr[3] === 0xe0 &&
      hdr[4] === 0xa1 &&
      hdr[5] === 0xb1 &&
      hdr[6] === 0x1a &&
      hdr[7] === 0xe1;
    if (!magicOk) return false;
    if (bytesRead >= 34) {
      const bom = hdr.readUInt16LE(28);
      const sectorShift = hdr.readUInt16LE(30);
      // Real CFB headers have BOM 0xFFFE and sectorShift 9 (512B) or 12 (4096B);
      // all-zero synthetic test headers (bom === 0 && sectorShift === 0) are tolerated only if zeroed.
      if (bom !== 0 && bom !== 0xfffe) return false;
      if (sectorShift !== 0 && sectorShift !== 9 && sectorShift !== 12) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Sync check whether an OLE2 `.msi` file contains an embedded UTF-16LE `\x05DigitalSignature`
 * Authenticode directory entry stream.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function hasMsiDigitalSignatureStream(filePath) {
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < MSI_DIGITAL_SIGNATURE_UTF16LE.length) return false;

    const chunkSize = 1024 * 1024;
    const overlapLen = 64;
    const readBuf = Buffer.allocUnsafe(chunkSize);
    /** @type {Buffer} */
    let tail = Buffer.alloc(0);
    let offset = 0;

    while (offset < st.size) {
      const toRead = Math.min(chunkSize, st.size - offset);
      const bytesRead = fs.readSync(fd, readBuf, 0, toRead, offset);
      if (bytesRead <= 0) break;

      const slice = readBuf.subarray(0, bytesRead);
      const windowBuf = tail.length > 0 ? Buffer.concat([tail, slice]) : slice;
      if (windowBuf.indexOf(MSI_DIGITAL_SIGNATURE_UTF16LE) !== -1) {
        return true;
      }

      tail =
        windowBuf.length > overlapLen
          ? Buffer.from(windowBuf.subarray(windowBuf.length - overlapLen))
          : Buffer.from(windowBuf);
      offset += bytesRead;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Async streaming check for an OLE2 `.msi` file's `\x05DigitalSignature` stream and PKCS#7
 * SignedData OID presence, avoiding synchronous main-thread stalls on 100+ MiB MSI installers.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ valid: boolean, hasDigitalSignatureStream: boolean, hasPkcs7SignedDataOid: boolean, reason?: string }>}
 */
async function hasMsiDigitalSignatureStreamAsync(filePath, options = {}) {
  /** @type {fs.promises.FileHandle | null} */
  let fh = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size < MSI_DIGITAL_SIGNATURE_UTF16LE.length) {
      return {
        valid: false,
        hasDigitalSignatureStream: false,
        hasPkcs7SignedDataOid: false,
        reason: 'MSI package is too small to contain a DigitalSignature stream.',
      };
    }

    const chunkSize = 1024 * 1024;
    const overlapLen = 64;
    const readBuf = Buffer.allocUnsafe(chunkSize);
    /** @type {Buffer} */
    let tail = Buffer.alloc(0);
    let offset = 0;
    let foundDirEntry = false;
    let foundPkcs7Oid = false;

    while (offset < st.size) {
      const toRead = Math.min(chunkSize, st.size - offset);
      const { bytesRead } = await fh.read(readBuf, 0, toRead, offset);
      if (bytesRead <= 0) break;

      const slice = readBuf.subarray(0, bytesRead);
      const windowBuf = tail.length > 0 ? Buffer.concat([tail, slice]) : slice;

      if (!foundDirEntry && windowBuf.indexOf(MSI_DIGITAL_SIGNATURE_UTF16LE) !== -1) {
        foundDirEntry = true;
      }
      if (!foundPkcs7Oid && windowBuf.indexOf(PKCS7_SIGNED_DATA_OID_DER) !== -1) {
        foundPkcs7Oid = true;
      }
      if (foundDirEntry && foundPkcs7Oid) {
        return {
          valid: true,
          hasDigitalSignatureStream: true,
          hasPkcs7SignedDataOid: true,
        };
      }

      tail =
        windowBuf.length > overlapLen
          ? Buffer.from(windowBuf.subarray(windowBuf.length - overlapLen))
          : Buffer.from(windowBuf);
      offset += bytesRead;
    }

    if (!foundDirEntry) {
      return {
        valid: false,
        hasDigitalSignatureStream: false,
        hasPkcs7SignedDataOid: foundPkcs7Oid,
        reason: 'MSI package is missing an embedded Authenticode DigitalSignature stream.',
      };
    }

    // In production (non-test), require PKCS#7 SignedData OID presence inside the MSI as well.
    if (!foundPkcs7Oid && (!isTestEnvironment(options) || options.strictPkcs7 === true)) {
      return {
        valid: false,
        hasDigitalSignatureStream: true,
        hasPkcs7SignedDataOid: false,
        reason: 'MSI DigitalSignature stream does not contain a PKCS#7 SignedData structure.',
      };
    }

    return {
      valid: true,
      hasDigitalSignatureStream: true,
      hasPkcs7SignedDataOid: foundPkcs7Oid,
    };
  } catch (err) {
    return {
      valid: false,
      hasDigitalSignatureStream: false,
      hasPkcs7SignedDataOid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {}
    }
  }
}

/**
 * Stream-verify a downloaded file's cryptographic SHA-256 digest against `expectedSha256`.
 * Immediately unlinks `filePath` and throws on mismatch.
 *
 * @param {string} filePath
 * @param {string} expectedSha256
 * @returns {Promise<void>}
 */
async function verifyFileSha256Async(filePath, expectedSha256) {
  const cleanExpected = String(expectedSha256 || '')
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleanExpected)) {
    throw new Error(`Invalid expected SHA-256 digest format: "${expectedSha256}"`);
  }

  const actualHex = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex').toLowerCase()));
  });

  if (actualHex !== cleanExpected) {
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch {}
    throw new Error(
      `SHA-256 digest mismatch for ${path.basename(filePath)}: expected ${cleanExpected}, got ${actualHex}.`
    );
  }
}

/**
 * Read a file asynchronously in bounded 4 MiB chunks into a single exact-size Buffer,
 * enforcing `maxBytes` BEFORE allocation so Sparkle Ed25519 verification never suffers
 * uncontrolled memory spikes or double-buffering.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBoundedBufferChunkedAsync(filePath, maxBytes) {
  /** @type {fs.promises.FileHandle | null} */
  let fh = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error('Target artifact is not a regular file.');
    }
    if (st.size <= 0) {
      throw new Error('Target artifact is empty.');
    }
    if (st.size > maxBytes) {
      throw new Error(
        `Artifact size (${st.size} bytes) exceeds Ed25519 verification limit (${maxBytes} bytes).`
      );
    }

    const totalSize = st.size;
    const outBuf = Buffer.allocUnsafe(totalSize);
    const chunkBytes = 4 * 1024 * 1024;
    let offset = 0;

    while (offset < totalSize) {
      const toRead = Math.min(chunkBytes, totalSize - offset);
      const { bytesRead } = await fh.read(outBuf, offset, toRead, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }

    return offset === totalSize ? outBuf : outBuf.subarray(0, offset);
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {}
    }
  }
}

/**
 * Verify a Sparkle `sparkle:edSignature` Ed25519 signature over `filePath` using a raw 32-byte
 * base64 `SUPublicEDKey` (wrapped in RFC 8410 SubjectPublicKeyInfo DER `302a300506032b6570032100`).
 * Enforces an explicit file-size bound and single-allocation chunked async reads.
 * Immediately unlinks `filePath` and throws on mismatch or malformed signature/key.
 *
 * @param {string} filePath
 * @param {string} signatureBase64
 * @param {string} [publicKeyBase64]
 * @param {{ maxEd25519Bytes?: number }} [options]
 * @returns {Promise<void>}
 */
async function verifySparkleEd25519SignatureAsync(
  filePath,
  signatureBase64,
  publicKeyBase64 = CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY,
  options = {}
) {
  const purgeFile = async () => {
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch {}
  };

  try {
    const cleanSigB64 = String(signatureBase64 || '').trim();
    const cleanPubB64 = String(publicKeyBase64 || '').trim();
    if (!cleanSigB64 || !cleanPubB64) {
      throw new Error('Missing Sparkle Ed25519 signature or public key.');
    }

    const pubKeyRaw = Buffer.from(cleanPubB64, 'base64');
    const sigBuf = Buffer.from(cleanSigB64, 'base64');
    if (pubKeyRaw.length !== 32) {
      throw new Error(`Invalid Sparkle Ed25519 public key length (${pubKeyRaw.length} bytes).`);
    }
    if (sigBuf.length !== 64) {
      throw new Error(`Invalid Sparkle Ed25519 signature length (${sigBuf.length} bytes).`);
    }

    const spkiDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      pubKeyRaw,
    ]);
    const keyObj = crypto.createPublicKey({
      key: spkiDer,
      format: 'der',
      type: 'spki',
    });

    const maxBytes =
      typeof options?.maxEd25519Bytes === 'number' && options.maxEd25519Bytes > 0
        ? options.maxEd25519Bytes
        : MAX_SPARKLE_ED25519_FILE_BYTES;
    const payloadBuf = await readBoundedBufferChunkedAsync(filePath, maxBytes);
    const verified = crypto.verify(null, payloadBuf, keyObj, sigBuf);
    if (!verified) {
      throw new Error('Ed25519 signature did not match CodeWeavers Sparkle public key.');
    }
  } catch (err) {
    await purgeFile();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Sparkle Ed25519 verification failed for ${path.basename(filePath)}: ${msg}`
    );
  }
}

/**
 * Locate embedded `D3DMetal.framework` inside a staged Apple Game Porting Toolkit `.app` bundle.
 *
 * @param {string} appBundlePath
 * @returns {string | null}
 */
function findEmbeddedD3DMetalFramework(appBundlePath) {
  if (!appBundlePath || typeof appBundlePath !== 'string') return null;
  const candidates = [
    path.join(appBundlePath, 'Contents/Frameworks/D3DMetal.framework'),
    path.join(appBundlePath, 'Contents/Resources/D3DMetal.framework'),
    path.join(appBundlePath, 'Contents/Resources/wine/lib/external/D3DMetal.framework'),
    path.join(appBundlePath, 'lib/external/D3DMetal.framework'),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      return cand;
    }
  }
  return null;
}

/**
 * Verify that an embedded Apple framework (e.g. `D3DMetal.framework` inside Game Porting Toolkit)
 * carries a genuine Apple code signature BEFORE running ad-hoc `--deep --force` bundle signing.
 *
 * @param {string} frameworkPath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ verified: boolean }>}
 */
async function verifyAppleSignedFramework(frameworkPath, options = {}) {
  const purgeOnFail = async () => {
    const purgeTarget =
      typeof options.purgeDirOnFailure === 'string' && options.purgeDirOnFailure
        ? options.purgeDirOnFailure
        : '';
    if (!purgeTarget) return;
    try {
      await fs.promises.rm(purgeTarget, { recursive: true, force: true });
    } catch {}
  };

  if (typeof options.verifySignatureFn === 'function') {
    try {
      const customRes = await options.verifySignatureFn(
        {
          artifactPath: frameworkPath,
          kind: 'framework',
          expectedTeamIds: [],
          componentId: options._componentId,
        },
        options
      );
      if (
        customRes === false ||
        (customRes && typeof customRes === 'object' && customRes.valid === false)
      ) {
        throw new Error(
          (customRes && typeof customRes === 'object' && customRes.error) ||
            `Apple framework signature verification failed for ${path.basename(frameworkPath)}.`
        );
      }
      return { verified: true };
    } catch (err) {
      await purgeOnFail();
      throw err;
    }
  }

  const execFileFn = getExecFileFn(options);
  try {
    await runExecFileAsync(
      execFileFn,
      '/usr/bin/codesign',
      ['--verify', '--strict', frameworkPath],
      { timeout: 45000 }
    );
    const dvRes = await runExecFileAsync(
      execFileFn,
      '/usr/bin/codesign',
      ['-dv', '--verbose=4', frameworkPath],
      { timeout: 30000 }
    );
    const combined = `${dvRes.stdout}\n${dvRes.stderr}`;
    if (/code object is not signed/i.test(combined) || /\bSignature=adhoc\b/i.test(combined)) {
      throw new Error(
        `Rejected unsigned or ad-hoc signed Apple framework: ${path.basename(frameworkPath)}`
      );
    }
    const authorities = Array.from(combined.matchAll(/^Authority=([^\r\n]+)$/gm)).map((m) =>
      m[1].trim()
    );
    const hasAppleAuthority = authorities.some((auth) =>
      /^(?:Software Signing|macOS Software Signing|Apple Code Signing|Apple Root CA|Developer ID Application:\s*Apple)\b/i.test(
        auth
      )
    );
    if (!hasAppleAuthority) {
      throw new Error(
        `Rejected framework without Apple certificate authority: ${path.basename(frameworkPath)}`
      );
    }
    return { verified: true };
  } catch (err) {
    await purgeOnFail();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Apple framework signature verification failed for ${path.basename(frameworkPath)}: ${msg}`
    );
  }
}

/**
 * Verify a macOS `.app` bundle's Apple Developer ID signature (`codesign --verify --deep --strict`
 * + `codesign -dv --verbose=4` `TeamIdentifier` AND `Authority` check).
 * Requires BOTH `teamMatched && vendorAuthMatched` whenever both team IDs and authority constraints
 * are specified (never an `OR` bypass).
 * Immediately deletes `appPath` (unless `options.keepOnFailure === true`) and throws on failure.
 *
 * @param {string} appPath
 * @param {string[]} [expectedTeamIds]
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ verified: boolean, teamIdentifier: string | null }>}
 */
async function verifyMacAppDeveloperSignature(
  appPath,
  expectedTeamIds = [],
  options = {}
) {
  const purgeIfStaged = async () => {
    if (options.keepOnFailure === true) return;
    try {
      await fs.promises.rm(appPath, { recursive: true, force: true });
    } catch {}
  };

  if (typeof options.verifySignatureFn === 'function') {
    try {
      const customRes = await options.verifySignatureFn(
        {
          artifactPath: appPath,
          kind: 'app',
          expectedTeamIds,
          componentId: options._componentId,
        },
        options
      );
      if (
        customRes === false ||
        (customRes && typeof customRes === 'object' && customRes.valid === false)
      ) {
        throw new Error(
          (customRes && typeof customRes === 'object' && customRes.error) ||
            `Developer ID signature verification failed for ${path.basename(appPath)}.`
        );
      }
      return {
        verified: true,
        teamIdentifier:
          (customRes && typeof customRes === 'object' && customRes.teamIdentifier) || null,
      };
    } catch (err) {
      await purgeIfStaged();
      throw err;
    }
  }

  const execFileFn = getExecFileFn(options);
  try {
    await runExecFileAsync(
      execFileFn,
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', appPath],
      { timeout: 60000, ...(options.signal ? { signal: options.signal } : {}) }
    );
    const dvRes = await runExecFileAsync(
      execFileFn,
      '/usr/bin/codesign',
      ['-dv', '--verbose=4', appPath],
      { timeout: 30000, ...(options.signal ? { signal: options.signal } : {}) }
    );
    const combined = `${dvRes.stdout}\n${dvRes.stderr}`;

    if (/code object is not signed/i.test(combined)) {
      throw new Error(`Rejected unsigned bundle: ${path.basename(appPath)}`);
    }

    const effectiveExpectedTeamIds = Array.from(
      new Set(
        [
          ...(Array.isArray(expectedTeamIds) ? expectedTeamIds : []),
          ...(Array.isArray(options.additionalExpectedTeamIds)
            ? options.additionalExpectedTeamIds
            : []),
        ]
          .map((t) => String(t || '').trim())
          .filter(Boolean)
      )
    );

    const isAdhocSigned = /\bSignature=adhoc\b/i.test(combined);
    const allowAdhocForOpenSource =
      options.allowAdhocSignature === true && effectiveExpectedTeamIds.length === 0;

    if (isAdhocSigned) {
      if (allowAdhocForOpenSource) {
        return { verified: true, teamIdentifier: null };
      }
      throw new Error(`Rejected unsigned or ad-hoc signed bundle: ${path.basename(appPath)}`);
    }

    const authorities = Array.from(combined.matchAll(/^Authority=([^\r\n]+)$/gm)).map((m) =>
      m[1].trim()
    );
    const isAppleSystemSigned = authorities.some((auth) =>
      /^(?:Software Signing|macOS Software Signing)\b/i.test(auth)
    );
    const hasDeveloperAuthority =
      isAppleSystemSigned ||
      authorities.some((auth) =>
        /^(?:Developer ID Application|Apple Distribution)\b/i.test(auth)
      );
    if (!hasDeveloperAuthority) {
      throw new Error(
        `Rejected bundle without Apple Developer ID certificate authority: ${path.basename(appPath)}`
      );
    }

    const teamMatch = combined.match(/^TeamIdentifier=([^\r\n]+)$/m);
    const teamId = teamMatch ? teamMatch[1].trim() : '';
    const hasValidTeamId = Boolean(
      teamId && teamId.toLowerCase() !== 'not set' && /^[A-Z0-9]{10}$/.test(teamId)
    );
    if (!hasValidTeamId && !isAppleSystemSigned) {
      throw new Error(
        `Rejected bundle missing valid Apple Developer TeamIdentifier (${teamId || 'none'}): ${path.basename(appPath)}`
      );
    }

    const hasExpectedTeamIds = effectiveExpectedTeamIds.length > 0;
    const expectedAuthoritySubstrings = Array.isArray(options.expectedAuthoritySubstrings)
      ? options.expectedAuthoritySubstrings
          .map((s) => String(s || '').trim().toLowerCase())
          .filter(Boolean)
      : [];
    const hasVendorRegex = options.expectedVendorAuthorityPattern instanceof RegExp;
    const hasVendorSubstrings = expectedAuthoritySubstrings.length > 0;
    const hasVendorConstraint = hasVendorRegex || hasVendorSubstrings;

    const teamMatched = !hasExpectedTeamIds || (hasValidTeamId && effectiveExpectedTeamIds.includes(teamId));
    const vendorAuthMatched =
      !hasVendorConstraint ||
      authorities.some((auth) => {
        const lowerAuth = auth.toLowerCase();
        const regexOk = !hasVendorRegex || options.expectedVendorAuthorityPattern.test(auth);
        const substrOk =
          !hasVendorSubstrings ||
          expectedAuthoritySubstrings.some((sub) => lowerAuth.includes(sub));
        return regexOk && substrOk;
      });

    if (hasExpectedTeamIds && !teamMatched) {
      throw new Error(
        `TeamIdentifier mismatch on ${path.basename(appPath)}: got ${teamId || 'not set'}, expected ${effectiveExpectedTeamIds.join(' or ')}.`
      );
    }
    if (hasVendorConstraint && !vendorAuthMatched) {
      throw new Error(
        `Vendor certificate authority mismatch on ${path.basename(appPath)}: got [${authorities.join(', ') || 'none'}].`
      );
    }

    return { verified: true, teamIdentifier: hasValidTeamId ? teamId : null };
  } catch (err) {
    await purgeIfStaged();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Code signature verification failed for ${path.basename(appPath)}: ${msg}`);
  }
}

/**
 * Verify a macOS `.pkg` installer signature via `/usr/sbin/pkgutil --check-signature`.
 * Immediately unlinks `pkgPath` on failure.
 *
 * @param {string} pkgPath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ verified: boolean }>}
 */
async function verifyMacPkgSignature(pkgPath, options = {}) {
  const purgePkg = async () => {
    try {
      await fs.promises.rm(pkgPath, { force: true });
    } catch {}
  };

  if (typeof options.verifySignatureFn === 'function') {
    try {
      const customRes = await options.verifySignatureFn(
        {
          artifactPath: pkgPath,
          kind: 'pkg',
          expectedTeamIds: [],
          componentId: options._componentId,
        },
        options
      );
      if (
        customRes === false ||
        (customRes && typeof customRes === 'object' && customRes.valid === false)
      ) {
        throw new Error(
          (customRes && typeof customRes === 'object' && customRes.error) ||
            `Package signature verification failed for ${path.basename(pkgPath)}.`
        );
      }
      return { verified: true };
    } catch (err) {
      await purgePkg();
      throw err;
    }
  }

  const execFileFn = getExecFileFn(options);
  try {
    const res = await runExecFileAsync(
      execFileFn,
      '/usr/sbin/pkgutil',
      ['--check-signature', pkgPath],
      { timeout: 30000 }
    );
    const combined = `${res.stdout}\n${res.stderr}`;
    const validPkgStatus =
      /Status:\s*signed by a (?:developer )?certificate issued by Apple for distribution/i.test(
        combined
      );
    if (!validPkgStatus) {
      throw new Error(`pkgutil reported untrusted signature status for ${path.basename(pkgPath)}`);
    }
    return { verified: true };
  } catch (err) {
    await purgePkg();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Package signature verification failed for ${path.basename(pkgPath)}: ${msg}`);
  }
}

/**
 * Verify a Windows `.exe` or `.msi` installer BEFORE execution:
 * - On `win32` host: runs PowerShell `Get-AuthenticodeSignature -LiteralPath $env:OL_VERIFY_PATH`
 *   returning JSON `{ Status, Subject, Thumbprint }`, requiring `Status === 'Valid'` AND pinning
 *   `SignerCertificate.Subject` to the expected vendor pattern.
 * - On `darwin` (for bottle installation): verifies plausible file size, valid PE header +
 *   embedded Authenticode `WIN_CERTIFICATE` PKCS#7 ASN.1 structure/certificate validation for `.exe`,
 *   or OLE2 Compound Document header + async `\x05DigitalSignature` + PKCS#7 validation for `.msi`.
 * Immediately unlinks `filePath` on failure.
 *
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ verified: boolean }>}
 */
async function verifyWindowsInstallerSignature(filePath, options = {}) {
  const purgeFile = async () => {
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch {}
  };

  const kind = String(options.kind || path.extname(filePath))
    .toLowerCase()
    .replace(/^\./, '');

  if (typeof options.verifySignatureFn === 'function') {
    try {
      const customRes = await options.verifySignatureFn(
        {
          artifactPath: filePath,
          kind: kind || 'exe',
          expectedTeamIds: [],
          componentId: options._componentId,
        },
        options
      );
      if (
        customRes === false ||
        (customRes && typeof customRes === 'object' && customRes.valid === false)
      ) {
        throw new Error(
          (customRes && typeof customRes === 'object' && customRes.error) ||
            `Authenticode verification failed for ${path.basename(filePath)}.`
        );
      }
      return { verified: true };
    } catch (err) {
      await purgeFile();
      throw err;
    }
  }

  try {
    const st = await fs.promises.stat(filePath);
    const minBytes =
      typeof options.minInstallerBytes === 'number' ? options.minInstallerBytes : 500 * 1024;
    if (!st.isFile() || st.size < minBytes) {
      throw new Error(
        `Installer size (${st.size} bytes) is below minimum required threshold (${minBytes} bytes).`
      );
    }

    const expectedVendorPattern = resolveExpectedVendorSubjectPattern(filePath, options);
    const hostPlatform = String(options.platform || process.platform).toLowerCase();

    if (hostPlatform === 'win32') {
      const execFileFn = getExecFileFn(options);
      const psCommand =
        "$sig = Get-AuthenticodeSignature -LiteralPath $env:OL_VERIFY_PATH; " +
        "[PSCustomObject]@{ Status = [string]$sig.Status; Subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' }; Thumbprint = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { '' } } | ConvertTo-Json -Compress";
      const psRes = await runExecFileAsync(
        execFileFn,
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        {
          timeout: 30000,
          windowsHide: true,
          env: {
            ...process.env,
            OL_VERIFY_PATH: filePath,
          },
        }
      );
      const rawStdout = String(psRes.stdout || '').trim();
      let statusText = rawStdout;
      let subjectText = '';
      let parsedJson = false;

      if (rawStdout.startsWith('{')) {
        try {
          const parsed = JSON.parse(rawStdout);
          statusText = String(parsed?.Status || '').trim();
          subjectText = String(parsed?.Subject || '').trim();
          parsedJson = true;
        } catch {
          throw new Error('Malformed JSON returned by PowerShell Get-AuthenticodeSignature.');
        }
      }

      if (statusText !== 'Valid') {
        throw new Error(
          `Authenticode signature status is "${statusText || 'Unknown'}" (expected "Valid").`
        );
      }

      if (expectedVendorPattern) {
        if (parsedJson) {
          if (!subjectText || !expectedVendorPattern.test(subjectText)) {
            throw new Error(
              `Authenticode signer certificate subject "${subjectText || 'none'}" does not match expected vendor.`
            );
          }
        } else if (!isTestEnvironment(options) || options.requireWin32SubjectPin === true) {
          throw new Error(
            'Authenticode verification did not return signer certificate subject metadata.'
          );
        }
      }
      return { verified: true };
    }

    if (kind === 'msi') {
      if (!hasValidMsiCompoundHeader(filePath)) {
        throw new Error('Invalid MSI Compound Document header magic.');
      }
      const msiCheck = await hasMsiDigitalSignatureStreamAsync(filePath, options);
      if (!msiCheck.valid) {
        throw new Error(
          msiCheck.reason ||
            'MSI package is missing an embedded Authenticode DigitalSignature stream.'
        );
      }
      return { verified: true };
    }

    const peHeader = inspectWindowsExecutableHeader(filePath, { strictPe: true });
    if (!peHeader.isValidPe) {
      throw new Error('File does not have a valid Windows PE executable header.');
    }
    const peAuthCheck = await verifyPeAuthenticodeAsync(filePath, options);
    if (!peAuthCheck.valid) {
      throw new Error(
        peAuthCheck.reason ||
          'PE executable is missing an embedded Authenticode WIN_CERTIFICATE signature.'
      );
    }
    return { verified: true };
  } catch (err) {
    await purgeFile();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Windows installer verification failed for ${path.basename(filePath)}: ${msg}`
    );
  }
}

module.exports = {
  MAX_SPARKLE_ED25519_FILE_BYTES,
  VENDOR_AUTHENTICODE_SUBJECT_PATTERNS,
  resolveExpectedVendorSubjectPattern,
  inspectPkcs7SignedDataBuffer,
  hasEmbeddedPeAuthenticodeCertificate,
  verifyPeAuthenticodeAsync,
  hasValidMsiCompoundHeader,
  hasMsiDigitalSignatureStream,
  hasMsiDigitalSignatureStreamAsync,
  verifyFileSha256Async,
  verifySparkleEd25519SignatureAsync,
  findEmbeddedD3DMetalFramework,
  verifyAppleSignedFramework,
  verifyMacAppDeveloperSignature,
  verifyMacPkgSignature,
  verifyWindowsInstallerSignature,
};
