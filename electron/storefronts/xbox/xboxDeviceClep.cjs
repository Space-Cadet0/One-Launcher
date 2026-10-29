'use strict';

/**
 * Virtual Windows Device Provisioning, `Clep` Challenge Generator, `RST2.srf` Device STS,
 * `<SPLicenseBlock>` Binary TLV Parser, `ClepSignState` Key Schedule & RFC 3394 `CIK` Unwrapper.
 *
 * Pure Node.js (`node:crypto`, `node:os`, `node:fs`, `node:path`) implementation ported bit-exactly
 * from the Windows `ClipSp` / `GamingServices` / `Xodus` protocol specification.
 * Works identically on macOS (`darwin`) and Windows (`win32`) with zero native add-ons and zero
 * macOS Keychain prompts (all credentials persisted inside One Launcher's encrypted `tokenVault.cjs`).
 */

const crypto = require('node:crypto');
const os = require('node:os');
const {
  RFC3394_DEFAULT_IV,
  aesKeyWrapRfc3394,
  aesKeyUnwrapRfc3394,
} = require('./xboxBoringSslCrypto.cjs');

const MSA_DEVICE_ADD_URL = 'https://login.live.com/ppsecure/deviceaddcredential.srf';
const MSA_RST2_URL = 'https://login.live.com/RST2.srf';
const MS_LICENSING_DEVICE_URL = 'https://licensing.mp.microsoft.com/v7.0/licenses/device';
const MS_LICENSING_CONTENT_URL = 'https://licensing.mp.microsoft.com/v7.0/licenses/content';
const MS_LICENSING_STORE_TOKEN_URL = 'https://licensing.mp.microsoft.com/v8.0/licenseToken';

const MSA_WINDOWS_USER_AGENT =
  'MSAWindows/55 (OS 10.0.26100.0.0 ge_release; IDK 10.0.26100.5074 ge_release; Cfg 16.000.29325.00; Test 0)';
const XBOX_LM_USER_AGENT =
  'XboxLm-PC/Microsoft.GamingServices_32.107.4002.0_x64__8wekyb3d8bbwe';

const HOSTING_APP_DEFAULT_IDCRL = '{DF60E2DF-88AD-4526-AE21-83D130EF0F68}';
const HOSTING_APP_MS_STORE = '{d6d5a677-0872-4ab0-9442-bb792fce85c5}';
const HOSTING_APP_TOKEN_BROKER = '{28C08266-F973-4AE6-FFE4-409B249F138F}';
const HOSTING_APP_XBOX_PC = '000000004424da1f';
const HMAC_KEY_USAGE = 'WS-SecureConversationWS-SecureConversation';
const LOCAL_USER_SID = 'S-1-5-21-0000000000-0000000000-0000000000-1001';

// SPLicense Block Tag IDs
const BLOCK_ID = Object.freeze({
  ENCRYPTED_DEVICE_KEY: 0x0001,
  PACKED_CONTENT_KEYS: 0x00ca,
  LICENSE_ID: 0x00cb,
  SIGNATURE_BLOCK: 0x00cc,
  PACKAGE_FULL_NAME: 0x00ce,
  HARDWARE_ID_BINDING: 0x00d0,
  POLICIES: 0x00d3,
  CMAC_SIGNATURE: 0x0101,
  CLEP_SIGN_STATE: 0x012d,
});

// ============================================================================
// 1. 32-bit Unsigned Bitwise Arithmetic & `Clep` Feistel Obfuscator
// ============================================================================

const CLEP_MAGIC_HI = 0x24181621 >>> 0;
const CLEP_MAGIC_LO = 0x41393243 >>> 0;
const CLEP_MAGIC_01 = 0x2418 >>> 0;
const CLEP_MAGIC_02 = 0x1621 >>> 0;
const CLEP_MAGIC_03 = 0x4139 >>> 0;
const CLEP_MAGIC_04 = 0x3243 >>> 0;

function u32(x) {
  return x >>> 0;
}

function rotr32(x, n) {
  const v = x >>> 0;
  const s = n & 31;
  return s === 0 ? v : ((v >>> s) | (v << (32 - s))) >>> 0;
}

function rotl32(x, n) {
  const v = x >>> 0;
  const s = n & 31;
  return s === 0 ? v : ((v << s) | (v >>> (32 - s))) >>> 0;
}

function add32(a, b) {
  return ((a >>> 0) + (b >>> 0)) >>> 0;
}

function sub32(a, b) {
  return ((a >>> 0) - (b >>> 0)) >>> 0;
}

function mul32(a, b) {
  return Math.imul(a >>> 0, b >>> 0) >>> 0;
}

function clepRound1(x) {
  return sub32(mul32(CLEP_MAGIC_04, rotr32((x ^ CLEP_MAGIC_HI) >>> 0, 22)), rotr32(x, 8));
}

function clepRound2(x) {
  return mul32(CLEP_MAGIC_04, (rotr32(x, 15) ^ CLEP_MAGIC_01) >>> 0);
}

function clepRound3(x) {
  return add32((x >>> 0) >>> 9, mul32(CLEP_MAGIC_02, rotl32((x ^ CLEP_MAGIC_03) >>> 0, 3)));
}

function clepRound4(x) {
  return (rotr32(x, 28) ^ mul32(CLEP_MAGIC_03, rotr32((x ^ CLEP_MAGIC_HI) >>> 0, 9))) >>> 0;
}

function clepRound5(x) {
  return add32(rotr32(x, 12), mul32(CLEP_MAGIC_04, rotr32(sub32(x, CLEP_MAGIC_HI), 14)));
}

function clepRound6(x) {
  return (rotr32(x, 11) ^ mul32(CLEP_MAGIC_01, rotl32((x ^ CLEP_MAGIC_02) >>> 0, 2))) >>> 0;
}

function clepRound7(x) {
  return sub32(sub32(x, CLEP_MAGIC_LO), CLEP_MAGIC_02);
}

function clepRound8(x) {
  return sub32(mul32(CLEP_MAGIC_03, rotl32((x ^ CLEP_MAGIC_01) >>> 0, 2)), rotr32(x, 18));
}

function clepRound0(x) {
  return sub32(mul32(CLEP_MAGIC_04, rotr32(sub32(x, CLEP_MAGIC_HI), 18)), rotr32(x, 9));
}

function clepWhiten(x) {
  return sub32(mul32(CLEP_MAGIC_03, rotr32(add32(x, CLEP_MAGIC_HI), 10)), rotr32(x, 29));
}

function clepRunRounds(a, b) {
  let s0 = a >>> 0;
  let s1 = b >>> 0;
  [s0, s1] = [s1, (s0 ^ clepRound1(s1)) >>> 0];
  [s0, s1] = [s1, (s0 ^ clepRound2(s1)) >>> 0];
  [s0, s1] = [s1, (s0 ^ clepRound3(s1)) >>> 0];
  [s0, s1] = [s1, (s0 ^ clepRound4(s1)) >>> 0];
  [s0, s1] = [s1, (s0 ^ clepRound5(s1)) >>> 0];
  [s0, s1] = [s1, (s0 ^ clepRound6(s1)) >>> 0];
  [s0, s1] = [s1, (s0 ^ clepRound7(s1)) >>> 0];
  [s0, s1] = [s1, (s0 ^ clepRound8(s1)) >>> 0];
  return [s0, s1];
}

function clepRunRoundsInverse(a, b) {
  let s0 = a >>> 0;
  let s1 = b >>> 0;
  [s0, s1] = [(s1 ^ clepRound8(s0)) >>> 0, s0];
  [s0, s1] = [(s1 ^ clepRound7(s0)) >>> 0, s0];
  [s0, s1] = [(s1 ^ clepRound6(s0)) >>> 0, s0];
  [s0, s1] = [(s1 ^ clepRound5(s0)) >>> 0, s0];
  [s0, s1] = [(s1 ^ clepRound4(s0)) >>> 0, s0];
  [s0, s1] = [(s1 ^ clepRound3(s0)) >>> 0, s0];
  [s0, s1] = [(s1 ^ clepRound2(s0)) >>> 0, s0];
  [s0, s1] = [(s1 ^ clepRound1(s0)) >>> 0, s0];
  return [s0, s1];
}

const CLEP_INITIAL_STATE = (() => {
  const k0 = (~mul32(CLEP_MAGIC_03, rotr32(CLEP_MAGIC_HI, 10))) >>> 0;
  const [, k8] = clepRunRounds(0, k0);
  return k8 >>> 0;
})();

/**
 * In-place (or cloned) `Clep` 2048-byte Feistel CBC obfuscator.
 * Matches `clep_obfuscate(&mut [u8; 2048])` in `ClipSp` / `Xodus` bit-for-bit.
 *
 * @param {Buffer} inputBuf 2048-byte ClepV2 or ClepV4 structure
 * @param {{ inPlace?: boolean }} [opts]
 * @returns {Buffer}
 */
function clepObfuscate(inputBuf, opts = {}) {
  if (!Buffer.isBuffer(inputBuf) || inputBuf.length !== 2048) {
    throw new Error(`clepObfuscate expects a 2048-byte Buffer (got ${inputBuf?.length})`);
  }
  const buf = opts.inPlace ? inputBuf : Buffer.from(inputBuf);

  const iv = buf.readUInt32LE(4);
  let lo = (CLEP_INITIAL_STATE ^ iv) >>> 0;
  let hi = 0;
  let plainLo = iv >>> 0;
  let plainHi = 0;

  buf.writeUInt32LE(lo, 4);

  for (let offset = 8; offset < 2048; offset += 8) {
    const blockLo = buf.readUInt32LE(offset);
    const blockHi = buf.readUInt32LE(offset + 4);

    const r0 = (lo ^ blockLo) >>> 0;
    const r1 = (hi ^ blockHi ^ clepRound0(r0)) >>> 0;
    const [r8, r9] = clepRunRoundsInverse(r0, r1);

    const newLo = (plainLo ^ r8 ^ clepWhiten(r9)) >>> 0;
    const newHi = (r9 ^ plainHi) >>> 0;

    lo = newLo;
    hi = newHi;
    plainLo = blockLo;
    plainHi = blockHi;

    buf.writeUInt32LE(newLo, offset);
    buf.writeUInt32LE(newHi, offset + 4);
  }

  return buf;
}

/**
 * Exact inverse of `clepObfuscate` for round-trip verification and inspection.
 *
 * @param {Buffer} inputBuf 2048-byte obfuscated Clep buffer
 * @param {{ inPlace?: boolean }} [opts]
 * @returns {Buffer}
 */
function clepDeobfuscate(inputBuf, opts = {}) {
  if (!Buffer.isBuffer(inputBuf) || inputBuf.length !== 2048) {
    throw new Error(`clepDeobfuscate expects a 2048-byte Buffer (got ${inputBuf?.length})`);
  }
  const buf = opts.inPlace ? inputBuf : Buffer.from(inputBuf);

  const obfIv = buf.readUInt32LE(4);
  const iv = (CLEP_INITIAL_STATE ^ obfIv) >>> 0;
  let lo = obfIv >>> 0;
  let hi = 0;
  let plainLo = iv >>> 0;
  let plainHi = 0;

  buf.writeUInt32LE(iv, 4);

  for (let offset = 8; offset < 2048; offset += 8) {
    const cipherLo = buf.readUInt32LE(offset);
    const cipherHi = buf.readUInt32LE(offset + 4);

    const r9 = (cipherHi ^ plainHi) >>> 0;
    const r8 = (cipherLo ^ plainLo ^ clepWhiten(r9)) >>> 0;
    const [r0, r1] = clepRunRounds(r8, r9);

    const blockLo = (lo ^ r0) >>> 0;
    const blockHi = (hi ^ r1 ^ clepRound0(r0)) >>> 0;

    lo = cipherLo;
    hi = cipherHi;
    plainLo = blockLo;
    plainHi = blockHi;

    buf.writeUInt32LE(blockLo, offset);
    buf.writeUInt32LE(blockHi, offset + 4);
  }

  return buf;
}

/**
 * Synthesizes deterministic 256-byte SMBIOS Type 1/2/3 tables + 64-byte Disk Serial
 * from a host hardware seed so device identity remains stable per machine without
 * requiring admin/IOKit/WMI privileges.
 *
 * @param {string} [hardwareSeed]
 * @returns {{ smbios: Buffer, diskSerial: Buffer }}
 */
function buildSyntheticHardwareTables(hardwareSeed) {
  const seed = String(
    hardwareSeed || `${os.platform()}|${os.arch()}|${os.hostname()}|one-launcher-xbox-v1`
  );
  const hashA = crypto.createHash('sha256').update(`smbios:${seed}`).digest();
  const hashB = crypto.createHash('sha256').update(`disk:${seed}`).digest();

  const smbios = Buffer.alloc(256, 0);
  // Minimal valid SMBIOS System Information (Type 1, length 0x1b, handle 0x0001)
  smbios[0] = 0x01;
  smbios[1] = 0x1b;
  smbios.writeUInt16LE(0x0001, 2);
  smbios[4] = 0x01; // Manufacturer string #1
  smbios[5] = 0x02; // Product Name string #2
  smbios[6] = 0x03; // Version string #3
  smbios[7] = 0x04; // Serial Number string #4
  hashA.subarray(0, 16).copy(smbios, 8); // 16-byte System UUID
  smbios[24] = 0x06; // Wake-up Type: Power Switch
  smbios[25] = 0x05; // SKU Number string #5
  smbios[26] = 0x06; // Family string #6
  const serialHex = hashA.subarray(16, 24).toString('hex').toUpperCase();
  const strings = [
    'System Manufacturer',
    'System Product Name',
    '1.0',
    `OL-${serialHex}`,
    'SKU-PC',
    'Desktop',
  ];
  let strOff = 0x1b;
  for (const s of strings) {
    const bytes = Buffer.from(s, 'ascii');
    if (strOff + bytes.length + 2 >= 254) break;
    bytes.copy(smbios, strOff);
    strOff += bytes.length + 1;
  }
  smbios[strOff] = 0x00; // Double-NUL structure terminator

  const diskSerial = Buffer.alloc(64, 0);
  const diskStr = `NVME-${hashB.subarray(0, 10).toString('hex').toUpperCase()}`;
  Buffer.from(diskStr, 'ascii').copy(diskSerial, 0);

  return { smbios, diskSerial };
}

/**
 * Builds ClepV2 and ClepV4 structures, obfuscates both, and formats the Base64-encoded
 * `<ClepRequest><V2>...</V2><V4>...</V4></ClepRequest>` clientChallenge expected by
 * `deviceaddcredential.srf` and `licensing.mp.microsoft.com/v7.0/licenses/*`.
 *
 * @param {{ smbios?: Buffer, diskSerial?: Buffer, hardwareSeed?: string }} [options]
 */
function buildClepChallengeBuffers(options = {}) {
  const synth =
    Buffer.isBuffer(options.smbios) &&
    options.smbios.length === 256 &&
    Buffer.isBuffer(options.diskSerial) &&
    options.diskSerial.length === 64
      ? { smbios: options.smbios, diskSerial: options.diskSerial }
      : buildSyntheticHardwareTables(options.hardwareSeed);

  // ClepV2 (2048 bytes packed)
  const clepV2Raw = Buffer.alloc(2048, 0);
  clepV2Raw.writeUInt32LE(2, 0); // version = 2
  synth.smbios.copy(clepV2Raw, 4); // 4..260
  synth.diskSerial.copy(clepV2Raw, 260); // 260..324
  clepV2Raw.writeUInt32LE(0, 324); // always_0 = 0
  clepV2Raw.writeUInt8(1, 328); // always_1 = true

  // ClepV4 (2048 bytes packed)
  const clepV4Raw = Buffer.alloc(2048, 0);
  clepV4Raw.writeUInt32LE(4, 0); // version = 4
  synth.smbios.copy(clepV4Raw, 4); // 4..260
  synth.diskSerial.copy(clepV4Raw, 260); // 260..324
  clepV4Raw.writeUInt32LE(1, 1231); // debugger_not_present = 1

  const clepV2 = clepObfuscate(clepV2Raw);
  const clepV4 = clepObfuscate(clepV4Raw);
  const clepV2B64 = clepV2.toString('base64');
  const clepV4B64 = clepV4.toString('base64');
  const xml = `<ClepRequest><V2>${clepV2B64}</V2><V4>${clepV4B64}</V4></ClepRequest>`;
  const clientChallenge = Buffer.from(xml, 'utf8').toString('base64');

  return {
    clepV2,
    clepV4,
    clepV2B64,
    clepV4B64,
    xml,
    clientChallenge,
  };
}

function getLicenseChallenge(options = {}) {
  return buildClepChallengeBuffers(options).clientChallenge;
}

// ============================================================================
// 2. `ClepSignState` / `EncryptedDeviceKey` Schedule, RSA-2048, AES-CMAC & CIK
// ============================================================================

/**
 * Derives the 16-byte AES-128 key from a 58-word (`u32[58]`, 232-byte LE) `Clep` key schedule.
 * Exact port of `decryption_key(&[u32; 58]) -> [u8; 16]` in `splicense.rs`.
 *
 * @param {Uint32Array | number[] | Buffer} schedule58
 * @returns {Buffer} 16-byte AES-128 key
 */
function deriveClepKeyFromSchedule(schedule58) {
  let words;
  if (Buffer.isBuffer(schedule58)) {
    if (schedule58.length < 58 * 4) {
      throw new Error(`Key schedule buffer too short (${schedule58.length} < 232 bytes)`);
    }
    words = new Uint32Array(58);
    for (let i = 0; i < 58; i++) {
      words[i] = schedule58.readUInt32LE(i * 4);
    }
  } else if (schedule58 instanceof Uint32Array || Array.isArray(schedule58)) {
    if (schedule58.length < 58) {
      throw new Error(`Key schedule array too short (${schedule58.length} < 58 words)`);
    }
    words = schedule58;
  } else {
    throw new Error('Invalid key schedule type');
  }

  const w0 = (words[46] ^ words[56] ^ 0xe20df371 ^ 0xccb22fe6) >>> 0;
  const w1 = (words[36] ^ words[47] ^ 0xdf080e39) >>> 0;
  const w2 = (words[40] ^ words[51] ^ 0x6d09b2f5 ^ 0x2ae17ab9) >>> 0;
  const w3 = (words[30] ^ words[41] ^ 0x37288cec) >>> 0;

  const out = Buffer.alloc(16);
  out.writeUInt32LE(w0, 0);
  out.writeUInt32LE(w1, 4);
  out.writeUInt32LE(w2, 8);
  out.writeUInt32LE(w3, 12);
  return out;
}

/**
 * Inverse helper for tests: constructs a 232-byte (`u32[58]`) key schedule that derives to `targetKey16`.
 *
 * @param {Buffer} targetKey16
 * @returns {Buffer} 232-byte LE key schedule
 */
function buildKeyScheduleForTargetKey(targetKey16) {
  if (!Buffer.isBuffer(targetKey16) || targetKey16.length !== 16) {
    throw new Error('targetKey16 must be a 16-byte Buffer');
  }
  const words = new Uint32Array(58);
  // Deterministic non-zero filler on unused slots, then solve slots 46, 36, 40, 30
  for (let i = 0; i < 58; i++) {
    words[i] = (0x01020304 + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  }
  const w0 = targetKey16.readUInt32LE(0);
  const w1 = targetKey16.readUInt32LE(4);
  const w2 = targetKey16.readUInt32LE(8);
  const w3 = targetKey16.readUInt32LE(12);

  words[46] = (w0 ^ words[56] ^ 0xe20df371 ^ 0xccb22fe6) >>> 0;
  words[36] = (w1 ^ words[47] ^ 0xdf080e39) >>> 0;
  words[40] = (w2 ^ words[51] ^ 0x6d09b2f5 ^ 0x2ae17ab9) >>> 0;
  words[30] = (w3 ^ words[41] ^ 0x37288cec) >>> 0;

  const buf = Buffer.alloc(58 * 4);
  for (let i = 0; i < 58; i++) {
    buf.writeUInt32LE(words[i], i * 4);
  }
  return buf;
}

function decryptCbcZeroIv(key16, ciphertext) {
  if (!Buffer.isBuffer(key16) || key16.length !== 16) {
    throw new Error('decryptCbcZeroIv requires a 16-byte AES-128 key');
  }
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error(`decryptCbcZeroIv requires non-empty 16-byte aligned buffer (got ${ciphertext?.length})`);
  }
  const decipher = crypto.createDecipheriv('aes-128-cbc', key16, Buffer.alloc(16, 0));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptCbcZeroIv(key16, plaintext) {
  if (!Buffer.isBuffer(key16) || key16.length !== 16) {
    throw new Error('encryptCbcZeroIv requires a 16-byte AES-128 key');
  }
  if (!Buffer.isBuffer(plaintext) || plaintext.length === 0 || plaintext.length % 16 !== 0) {
    throw new Error(`encryptCbcZeroIv requires non-empty 16-byte aligned buffer (got ${plaintext?.length})`);
  }
  const cipher = crypto.createCipheriv('aes-128-cbc', key16, Buffer.alloc(16, 0));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function shiftLeftOne128(block16) {
  const out = Buffer.alloc(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const b = block16[i];
    out[i] = ((b << 1) | carry) & 0xff;
    carry = (b >>> 7) & 1;
  }
  return out;
}

function xorBlock16(a, b) {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}

function aes128EcbBlock(key16, block16) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key16, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block16), cipher.final()]);
}

/**
 * Pure Node.js RFC 4493 / NIST SP 800-38B `AES-128-CMAC` implementation.
 *
 * @param {Buffer} key16 16-byte AES-128 key
 * @param {Buffer} message arbitrary-length message buffer
 * @returns {Buffer} 16-byte CMAC tag
 */
function aes128Cmac(key16, message) {
  if (!Buffer.isBuffer(key16) || key16.length !== 16) {
    throw new Error('aes128Cmac requires a 16-byte key');
  }
  const msg = Buffer.isBuffer(message) ? message : Buffer.from(message || '');
  const Rb = 0x87;

  const L = aes128EcbBlock(key16, Buffer.alloc(16, 0));
  const K1 = shiftLeftOne128(L);
  if (L[0] & 0x80) K1[15] ^= Rb;
  const K2 = shiftLeftOne128(K1);
  if (K1[0] & 0x80) K2[15] ^= Rb;

  const n = msg.length === 0 ? 1 : Math.ceil(msg.length / 16);
  const isComplete = msg.length > 0 && msg.length % 16 === 0;

  let mLast;
  if (isComplete) {
    mLast = xorBlock16(msg.subarray((n - 1) * 16, n * 16), K1);
  } else {
    const padded = Buffer.alloc(16, 0);
    const rem = msg.subarray((n - 1) * 16);
    rem.copy(padded, 0);
    padded[rem.length] = 0x80;
    mLast = xorBlock16(padded, K2);
  }

  let x = Buffer.alloc(16, 0);
  for (let i = 0; i < n - 1; i++) {
    const y = xorBlock16(x, msg.subarray(i * 16, (i + 1) * 16));
    x = aes128EcbBlock(key16, y);
  }
  return aes128EcbBlock(key16, xorBlock16(x, mLast));
}

function bigIntFromBeBuffer(buf) {
  if (!buf || buf.length === 0) return 0n;
  return BigInt('0x' + buf.toString('hex'));
}

function bigIntToBase64Url(value, minByteLen = 0) {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  let buf = Buffer.from(hex, 'hex');
  if (minByteLen > 0 && buf.length < minByteLen) {
    const padded = Buffer.alloc(minByteLen, 0);
    buf.copy(padded, minByteLen - buf.length);
    buf = padded;
  }
  return buf.toString('base64url');
}

function gcdBigInt(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * @param {bigint} a
 * @param {bigint} m
 * @returns {bigint}
 */
function modInverseBigInt(a, m) {
  let m0 = m;
  let x0 = 0n;
  let x1 = 1n;
  let cur = ((a % m) + m) % m;
  if (m === 1n) return 0n;
  while (cur > 1n) {
    const q = cur / m0;
    let t = m0;
    m0 = cur % m0;
    cur = t;
    t = x0;
    x0 = x1 - q * x0;
    x1 = t;
  }
  if (x1 < 0n) x1 += m;
  return x1;
}

/**
 * Parses a Windows `BCRYPT_RSAKEY_BLOB` (`RSA2` = `0x32415352` or `RSA3` = `0x33415352`)
 * from `ClepSignState` (`0x012d`) and converts it to a standard PKCS#8 PEM private key.
 *
 * @param {Buffer} blob
 * @returns {string} PKCS#8 PEM private key
 */
function parseBcryptRsaPrivateKeyToPem(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 24) {
    throw new Error('Invalid BCRYPT_RSAKEY_BLOB buffer');
  }
  const magic = blob.readUInt32LE(0);
  // 0x32415352 = "RSA2" (BCRYPT_RSAPRIVATE_MAGIC), 0x33415352 = "RSA3" (BCRYPT_RSAFULLPRIVATE_MAGIC)
  if (magic !== 0x32415352 && magic !== 0x33415352) {
    throw new Error(`Unexpected BCRYPT_RSAKEY_BLOB magic: 0x${magic.toString(16)}`);
  }

  const bitLength = blob.readUInt32LE(4);
  const cbPublicExp = blob.readUInt32LE(8);
  const cbModulus = blob.readUInt32LE(12);
  const cbPrime1 = blob.readUInt32LE(16);
  const cbPrime2 = blob.readUInt32LE(20);

  const needed = 24 + cbPublicExp + cbModulus + cbPrime1 + cbPrime2;
  if (blob.length < needed || cbPublicExp === 0 || cbModulus === 0 || cbPrime1 === 0 || cbPrime2 === 0) {
    throw new Error(`Truncated BCRYPT_RSAKEY_BLOB (${blob.length} < ${needed}, bits=${bitLength})`);
  }

  let off = 24;
  const eBuf = blob.subarray(off, off + cbPublicExp);
  off += cbPublicExp;
  const nBuf = blob.subarray(off, off + cbModulus);
  off += cbModulus;
  const pBuf = blob.subarray(off, off + cbPrime1);
  off += cbPrime1;
  const qBuf = blob.subarray(off, off + cbPrime2);

  const e = bigIntFromBeBuffer(eBuf);
  const n = bigIntFromBeBuffer(nBuf);
  const p = bigIntFromBeBuffer(pBuf);
  const q = bigIntFromBeBuffer(qBuf);

  const pMinus1 = p - 1n;
  const qMinus1 = q - 1n;
  const lambda = (pMinus1 * qMinus1) / gcdBigInt(pMinus1, qMinus1);
  const d = modInverseBigInt(e, lambda);
  const dp = d % pMinus1;
  const dq = d % qMinus1;
  const qi = modInverseBigInt(q, p);

  const jwk = {
    kty: 'RSA',
    n: nBuf.toString('base64url'),
    e: eBuf.toString('base64url'),
    d: bigIntToBase64Url(d, cbModulus),
    p: pBuf.toString('base64url'),
    q: qBuf.toString('base64url'),
    dp: bigIntToBase64Url(dp, cbPrime1),
    dq: bigIntToBase64Url(dq, cbPrime2),
    qi: bigIntToBase64Url(qi, cbPrime1),
  };

  const keyObj = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return keyObj.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/**
 * Helper to serialize an existing Node RSA private key PEM into a 544-byte `BCRYPT_RSAKEY_BLOB` (`RSA2`)
 * for unit-test vector construction.
 *
 * @param {string | crypto.KeyObject} privateKeyPemOrObj
 * @returns {Buffer} 544-byte `RSA2` blob
 */
function exportPemToBcryptRsa2Blob(privateKeyPemOrObj) {
  const keyObj =
    typeof privateKeyPemOrObj === 'string'
      ? crypto.createPrivateKey(privateKeyPemOrObj)
      : privateKeyPemOrObj;
  const jwk = keyObj.export({ format: 'jwk' });
  const eBuf = Buffer.from(jwk.e, 'base64url');
  const nBuf = Buffer.from(jwk.n, 'base64url');
  const pBuf = Buffer.from(jwk.p, 'base64url');
  const qBuf = Buffer.from(jwk.q, 'base64url');

  const totalLen = Math.max(544, 24 + eBuf.length + nBuf.length + pBuf.length + qBuf.length);
  const out = Buffer.alloc(totalLen, 0);
  out.writeUInt32LE(0x32415352, 0); // "RSA2"
  out.writeUInt32LE(nBuf.length * 8, 4);
  out.writeUInt32LE(eBuf.length, 8);
  out.writeUInt32LE(nBuf.length, 12);
  out.writeUInt32LE(pBuf.length, 16);
  out.writeUInt32LE(qBuf.length, 20);

  let off = 24;
  eBuf.copy(out, off);
  off += eBuf.length;
  nBuf.copy(out, off);
  off += nBuf.length;
  pBuf.copy(out, off);
  off += pBuf.length;
  qBuf.copy(out, off);
  return out;
}

function formatMixedEndianGuid(buf16) {
  if (!Buffer.isBuffer(buf16) || buf16.length < 16) return '';
  const d1 = buf16.readUInt32LE(0).toString(16).padStart(8, '0');
  const d2 = buf16.readUInt16LE(4).toString(16).padStart(4, '0');
  const d3 = buf16.readUInt16LE(6).toString(16).padStart(4, '0');
  const d4 = buf16.subarray(8, 10).toString('hex');
  const d5 = buf16.subarray(10, 16).toString('hex');
  return `${d1}-${d2}-${d3}-${d4}-${d5}`.toLowerCase();
}

function encodeMixedEndianGuid(guidStr) {
  const clean = String(guidStr || '')
    .trim()
    .replace(/^\{|\}$/g, '')
    .toLowerCase();
  const m = clean.match(/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/);
  if (!m) {
    throw new Error(`Invalid GUID string: ${guidStr}`);
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(parseInt(m[1], 16) >>> 0, 0);
  out.writeUInt16LE(parseInt(m[2], 16) & 0xffff, 4);
  out.writeUInt16LE(parseInt(m[3], 16) & 0xffff, 6);
  Buffer.from(m[4] + m[5], 'hex').copy(out, 8);
  return out;
}

/**
 * Unwraps a 40-byte RFC 3394 AES-128 Key-Wrapped Content Integrity Key (`CIK`) using the
 * 16-byte `DeviceKey` (`IV = A6A6A6A6A6A6A6A6`) into the 32-byte raw XVD `CIK`.
 *
 * @param {Buffer} wrappedCik40 40-byte wrapped key from SPLicense Tag `0x00ca`
 * @param {Buffer} deviceKey16 16-byte unwrapped DeviceKey
 * @returns {Buffer} 32-byte raw CIK
 */
function unwrapContentCik(wrappedCik40, deviceKey16) {
  if (!Buffer.isBuffer(wrappedCik40) || wrappedCik40.length !== 40) {
    throw new Error(`unwrapContentCik expects a 40-byte wrapped CIK (got ${wrappedCik40?.length})`);
  }
  if (!Buffer.isBuffer(deviceKey16) || deviceKey16.length !== 16) {
    throw new Error(`unwrapContentCik expects a 16-byte deviceKey (got ${deviceKey16?.length})`);
  }
  return aesKeyUnwrapRfc3394(wrappedCik40, deviceKey16, RFC3394_DEFAULT_IV);
}

/**
 * Wraps a 32-byte raw `CIK` with RFC 3394 AES-128 Key Wrap (`IV = A6A6A6A6A6A6A6A6`) into a 40-byte wrapped CIK.
 *
 * @param {Buffer} cik32 32-byte raw CIK
 * @param {Buffer} deviceKey16 16-byte DeviceKey
 * @returns {Buffer} 40-byte wrapped CIK
 */
function wrapContentCik(cik32, deviceKey16) {
  if (!Buffer.isBuffer(cik32) || cik32.length !== 32) {
    throw new Error(`wrapContentCik expects a 32-byte CIK (got ${cik32?.length})`);
  }
  if (!Buffer.isBuffer(deviceKey16) || deviceKey16.length !== 16) {
    throw new Error(`wrapContentCik expects a 16-byte deviceKey (got ${deviceKey16?.length})`);
  }
  return aesKeyWrapRfc3394(cik32, deviceKey16, RFC3394_DEFAULT_IV);
}

/**
 * Decodes an outer XML string when `rawXmlOrBase64` is either raw XML (`<License ...>`)
 * or Base64-encoded XML (`<License ...>`), returning `null` for bare binary TLV Base64.
 *
 * @param {string} rawXmlOrBase64
 * @returns {string | null}
 */
function decodeSpLicenseXmlIfPresent(rawXmlOrBase64) {
  const str = String(rawXmlOrBase64 || '').trim();
  if (!str) return null;

  const strippedStr = str.replace(/^\uFEFF/, '').trimStart();
  if (strippedStr.startsWith('<') || /<(?:[\w-]+:)?SPLicenseBlock\b/i.test(strippedStr)) {
    return strippedStr;
  }

  // Live `licensing.mp.microsoft.com/v7.0/licenses/content` returns `license.keys[].value` / `licenseBlob`
  // as Base64-encoded `<License xmlns:xsi=...>` XML without `<?xml` where `<SPLicenseBlock>`
  // appears past offset ~400-978 chars. Inspect the decoded prefix for `<` and return the full XML!
  try {
    const decoded = Buffer.from(str, 'base64');
    if (decoded.length > 0) {
      const headUtf8 = decoded
        .subarray(0, Math.min(decoded.length, 64))
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trimStart();
      if (headUtf8.startsWith('<')) {
        return decoded.toString('utf8').replace(/^\uFEFF/, '');
      }
    }
  } catch {}

  return null;
}

/**
 * Extracts all `<SPLicenseBlock>...</SPLicenseBlock>` Base64 payloads if wrapped in XML
 * (either raw XML or Base64-encoded `<License ...>` XML of arbitrary preamble length),
 * or returns `[trimmedBase64]` if already a bare binary `SPLicenseBlock` Base64 string.
 *
 * @param {string} rawXmlOrBase64
 * @returns {string[]}
 */
function extractAllSpLicenseBase64Blocks(rawXmlOrBase64) {
  const str = String(rawXmlOrBase64 || '').trim();
  if (!str) return [];

  const extractBlocksFromXml = (/** @type {string} */ xmlText) => {
    const matches = [];
    const re = /<(?:[\w-]+:)?SPLicenseBlock[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?SPLicenseBlock>/gi;
    let m;
    while ((m = re.exec(xmlText)) !== null) {
      const cleaned = String(m[1] || '').replace(/\s+/g, '');
      if (cleaned) matches.push(cleaned);
    }
    return matches;
  };

  const decodedXml = decodeSpLicenseXmlIfPresent(str);
  if (decodedXml !== null) {
    return extractBlocksFromXml(decodedXml);
  }

  return [str.replace(/\s+/g, '')];
}

/**
 * Extracts the primary `<SPLicenseBlock>...</SPLicenseBlock>` Base64 payload if wrapped in XML,
 * or returns raw Base64 string if already unwrapped.
 *
 * @param {string} rawXmlOrBase64
 * @returns {string}
 */
function extractSpLicenseBase64(rawXmlOrBase64) {
  const blocks = extractAllSpLicenseBase64Blocks(rawXmlOrBase64);
  return blocks[0] || '';
}

const XMLDSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
const XML_EXC_C14N_NS = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const XMLDSIG_RSA_SHA256_URI = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const XMLENC_SHA256_URI = 'http://www.w3.org/2001/04/xmlenc#sha256';

/**
 * @typedef {{ type: 'text', value: string }} XmlC14nTextNode
 * @typedef {{ qname: string, prefix: string, localName: string, namespaceUri: string, value: string }} XmlC14nAttr
 * @typedef {{
 *   type: 'element',
 *   qname: string,
 *   prefix: string,
 *   localName: string,
 *   namespaceUri: string,
 *   nsScope: Map<string, string>,
 *   attrs: XmlC14nAttr[],
 *   children: Array<XmlC14nElementNode | XmlC14nTextNode>,
 *   parent: XmlC14nElementNode | null,
 * }} XmlC14nElementNode
 */

/**
 * @param {string} str
 * @param {boolean} [isAttribute]
 * @returns {string}
 */
function decodeXmlEntitiesForC14n(str, isAttribute = false) {
  let s = String(str ?? '');
  if (isAttribute) {
    // XML 1.0 §3.3.3: literal whitespace chars (\t, \n, \r) normalize to 0x20 before entity expansion
    s = s.replace(/[\t\n\r]/g, ' ');
  }
  return s.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-fA-F]+|#\d+);/g, (full, ent) => {
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    if (ent === 'quot') return '"';
    if (ent === 'apos') return "'";
    if (ent === 'amp') return '&';
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const cp = parseInt(ent.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    if (ent.startsWith('#')) {
      const cp = parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    return full;
  });
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeC14nText(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeC14nAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareCodepoints(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @param {Buffer} buf
 * @returns {string}
 */
function toUnsignedBase64Url(buf) {
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0x00) {
    start += 1;
  }
  return buf.subarray(start).toString('base64url');
}

/**
 * Parses a well-formed XML document into an element/text tree with full namespace scope tracking
 * for W3C Canonical XML 1.0 (Inclusive & Exclusive).
 *
 * @param {string} rawXml
 * @returns {XmlC14nElementNode}
 */
function parseXmlDocumentForC14n(rawXml) {
  const xml = String(rawXml ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

  let pos = 0;
  const len = xml.length;
  /** @type {XmlC14nElementNode[]} */
  const stack = [];
  /** @type {XmlC14nElementNode | null} */
  let root = null;

  const appendText = (/** @type {string} */ txt) => {
    if (!txt || stack.length === 0) return;
    stack[stack.length - 1].children.push({ type: 'text', value: txt });
  };

  while (pos < len) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) {
      appendText(decodeXmlEntitiesForC14n(xml.slice(pos), false));
      break;
    }
    if (lt > pos) {
      appendText(decodeXmlEntitiesForC14n(xml.slice(pos, lt), false));
    }

    if (xml.startsWith('<!--', lt)) {
      const endComment = xml.indexOf('-->', lt + 4);
      if (endComment === -1) throw new Error('Malformed XML comment');
      pos = endComment + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const endCdata = xml.indexOf(']]>', lt + 9);
      if (endCdata === -1) throw new Error('Malformed XML CDATA');
      appendText(xml.slice(lt + 9, endCdata));
      pos = endCdata + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const endPi = xml.indexOf('?>', lt + 2);
      if (endPi === -1) throw new Error('Malformed XML processing instruction');
      pos = endPi + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const endDecl = xml.indexOf('>', lt + 2);
      if (endDecl === -1) throw new Error('Malformed XML declaration');
      pos = endDecl + 1;
      continue;
    }

    if (xml[lt + 1] === '/') {
      const gt = xml.indexOf('>', lt + 2);
      if (gt === -1) throw new Error('Malformed XML closing tag');
      const closeQName = xml.slice(lt + 2, gt).trim();
      const top = stack.pop();
      if (!top || top.qname !== closeQName) {
        throw new Error('Mismatched XML closing tag');
      }
      pos = gt + 1;
      continue;
    }

    let cur = lt + 1;
    while (cur < len && !/[\s/>]/.test(xml[cur])) cur += 1;
    const qname = xml.slice(lt + 1, cur);
    if (!qname) throw new Error('Empty XML element name');

    /** @type {Array<{ prefix: string, uri: string }>} */
    const nsDecls = [];
    /** @type {Array<{ qname: string, value: string }>} */
    const rawAttrs = [];
    let selfClosing = false;

    while (cur < len) {
      while (cur < len && /\s/.test(xml[cur])) cur += 1;
      if (cur >= len) throw new Error('Unterminated XML start tag');
      if (xml[cur] === '>') {
        cur += 1;
        break;
      }
      if (xml[cur] === '/' && xml[cur + 1] === '>') {
        selfClosing = true;
        cur += 2;
        break;
      }

      const nameStart = cur;
      while (cur < len && !/[\s=/>]/.test(xml[cur])) cur += 1;
      const attrName = xml.slice(nameStart, cur);
      if (!attrName) throw new Error('Invalid XML attribute name');
      while (cur < len && /\s/.test(xml[cur])) cur += 1;
      if (xml[cur] !== '=') throw new Error('Missing "=" in XML attribute');
      cur += 1;
      while (cur < len && /\s/.test(xml[cur])) cur += 1;
      const quote = xml[cur];
      if (quote !== '"' && quote !== "'") throw new Error('Missing quote in XML attribute');
      cur += 1;
      const valStart = cur;
      const valEnd = xml.indexOf(quote, valStart);
      if (valEnd === -1) throw new Error('Unterminated XML attribute value');
      const attrVal = decodeXmlEntitiesForC14n(xml.slice(valStart, valEnd), true);
      cur = valEnd + 1;

      if (attrName === 'xmlns') {
        nsDecls.push({ prefix: '', uri: attrVal });
      } else if (attrName.startsWith('xmlns:')) {
        nsDecls.push({ prefix: attrName.slice(6), uri: attrVal });
      } else {
        rawAttrs.push({ qname: attrName, value: attrVal });
      }
    }

    const parentElem = stack.length > 0 ? stack[stack.length - 1] : null;
    const baseScope = parentElem
      ? parentElem.nsScope
      : new Map([
          ['', ''],
          ['xml', 'http://www.w3.org/XML/1998/namespace'],
        ]);
    const nsScope = new Map(baseScope);
    for (const d of nsDecls) {
      nsScope.set(d.prefix, d.uri);
    }

    const colonIdx = qname.indexOf(':');
    const prefix = colonIdx === -1 ? '' : qname.slice(0, colonIdx);
    const localName = colonIdx === -1 ? qname : qname.slice(colonIdx + 1);
    const namespaceUri = nsScope.get(prefix) ?? '';

    const attrs = rawAttrs.map((a) => {
      const cIdx = a.qname.indexOf(':');
      const aPrefix = cIdx === -1 ? '' : a.qname.slice(0, cIdx);
      const aLocal = cIdx === -1 ? a.qname : a.qname.slice(cIdx + 1);
      const aNs = aPrefix ? (nsScope.get(aPrefix) ?? '') : '';
      return {
        qname: a.qname,
        prefix: aPrefix,
        localName: aLocal,
        namespaceUri: aNs,
        value: a.value,
      };
    });

    /** @type {XmlC14nElementNode} */
    const elem = {
      type: 'element',
      qname,
      prefix,
      localName,
      namespaceUri,
      nsScope,
      attrs,
      children: [],
      parent: parentElem,
    };

    if (parentElem) {
      parentElem.children.push(elem);
    } else {
      if (root) throw new Error('Multiple XML root elements');
      root = elem;
    }

    if (!selfClosing) {
      stack.push(elem);
    }
    pos = cur;
  }

  if (stack.length > 0 || !root) {
    throw new Error('Malformed XML document');
  }
  return root;
}

/**
 * Serializes a parsed XML subtree in W3C Inclusive C14N 1.0 or Exclusive C14N 1.0 form.
 *
 * @param {XmlC14nElementNode | XmlC14nTextNode} node
 * @param {{
 *   exclusive?: boolean,
 *   inclusivePrefixes?: Set<string>,
 *   skipElement?: XmlC14nElementNode | null,
 * }} [options]
 * @param {Map<string, string>} [renderedNs]
 * @returns {string}
 */
function serializeC14nNode(
  node,
  options = {},
  renderedNs = new Map([
    ['', ''],
    ['xml', 'http://www.w3.org/XML/1998/namespace'],
  ])
) {
  if (node.type === 'text') {
    return escapeC14nText(node.value);
  }
  if (options.skipElement && node === options.skipElement) {
    return '';
  }

  const nextRenderedNs = new Map(renderedNs);
  /** @type {Array<{ prefix: string, uri: string }>} */
  const nsToEmit = [];

  if (!options.exclusive) {
    const sortedScope = Array.from(node.nsScope.entries()).sort((a, b) =>
      compareCodepoints(a[0], b[0])
    );
    for (const [pfx, uri] of sortedScope) {
      if (pfx === 'xml') continue;
      const prev = renderedNs.get(pfx) ?? '';
      if (pfx === '') {
        if (uri !== prev) {
          nsToEmit.push({ prefix: '', uri });
          nextRenderedNs.set('', uri);
        }
      } else if (uri !== '' && uri !== prev) {
        nsToEmit.push({ prefix: pfx, uri });
        nextRenderedNs.set(pfx, uri);
      }
    }
  } else {
    const utilizedPrefixes = new Set([node.prefix]);
    for (const a of node.attrs) {
      if (a.prefix && a.prefix !== 'xml') {
        utilizedPrefixes.add(a.prefix);
      }
    }
    if (options.inclusivePrefixes) {
      for (const p of options.inclusivePrefixes) {
        utilizedPrefixes.add(p === '#default' ? '' : p);
      }
    }
    const sortedPfx = Array.from(utilizedPrefixes).sort(compareCodepoints);
    for (const pfx of sortedPfx) {
      if (pfx === 'xml') continue;
      const uri = node.nsScope.get(pfx) ?? '';
      const prev = renderedNs.get(pfx) ?? '';
      if (pfx === '') {
        if (uri !== prev) {
          nsToEmit.push({ prefix: '', uri });
          nextRenderedNs.set('', uri);
        }
      } else if (uri !== '' && uri !== prev) {
        nsToEmit.push({ prefix: pfx, uri });
        nextRenderedNs.set(pfx, uri);
      }
    }
  }

  const sortedAttrs = node.attrs.slice().sort((a, b) => {
    const nsCmp = compareCodepoints(a.namespaceUri, b.namespaceUri);
    return nsCmp !== 0 ? nsCmp : compareCodepoints(a.localName, b.localName);
  });

  let out = `<${node.qname}`;
  for (const ns of nsToEmit) {
    if (ns.prefix === '') {
      out += ` xmlns="${escapeC14nAttr(ns.uri)}"`;
    } else {
      out += ` xmlns:${ns.prefix}="${escapeC14nAttr(ns.uri)}"`;
    }
  }
  for (const attr of sortedAttrs) {
    out += ` ${attr.qname}="${escapeC14nAttr(attr.value)}"`;
  }
  out += '>';
  for (const child of node.children) {
    out += serializeC14nNode(child, options, nextRenderedNs);
  }
  out += `</${node.qname}>`;
  return out;
}

/**
 * @param {XmlC14nElementNode} elem
 * @param {string} localName
 * @param {string} [nsUri]
 * @returns {XmlC14nElementNode | null}
 */
function findDirectChildElement(elem, localName, nsUri) {
  for (const c of elem.children) {
    if (c.type === 'element' && c.localName === localName && (!nsUri || c.namespaceUri === nsUri)) {
      return c;
    }
  }
  return null;
}

/**
 * @param {XmlC14nElementNode} elem
 * @param {string} localName
 * @param {string} [nsUri]
 * @returns {XmlC14nElementNode | null}
 */
function findDescendantElement(elem, localName, nsUri) {
  for (const c of elem.children) {
    if (c.type !== 'element') continue;
    if (c.localName === localName && (!nsUri || c.namespaceUri === nsUri)) {
      return c;
    }
    const nested = findDescendantElement(c, localName, nsUri);
    if (nested) return nested;
  }
  return null;
}

/**
 * @param {XmlC14nElementNode | null} elem
 * @returns {string}
 */
function collectElementText(elem) {
  if (!elem) return '';
  let out = '';
  for (const c of elem.children) {
    if (c.type === 'text') out += c.value;
    else out += collectElementText(c);
  }
  return out;
}

/**
 * @returns {Error & { code: string }}
 */
function makeXmlDsigTamperedError() {
  return Object.assign(new Error('SPLicense XML-DSig verification failed'), {
    code: 'SPLICENSE_SIGNATURE_TAMPERED',
  });
}

/**
 * Verifies an enveloped W3C XML-DSig (`http://www.w3.org/2000/09/xmldsig#`) `RSA-SHA256` signature
 * and `SHA-256` `<DigestValue>` when present on a Microsoft Store `<License>` XML payload
 * (accepting either raw XML text or Base64-encoded `<License>` XML).
 *
 * Returns `true` when an XML-DSig signature is present and verified, `false` when no enveloped
 * XML-DSig `<Signature>` is present, and throws `SPLICENSE_SIGNATURE_TAMPERED` if either
 * `<DigestValue>` or `<SignatureValue>` fails verification or is malformed.
 *
 * @param {string} xmlText
 * @returns {boolean}
 */
function verifyLicenseXmlDsigIfPresent(xmlText) {
  const decodedXml = decodeSpLicenseXmlIfPresent(xmlText);
  if (decodedXml === null) {
    return false;
  }
  if (!/<(?:[\w-]+:)?Signature\b/i.test(decodedXml)) {
    return false;
  }

  /** @type {XmlC14nElementNode} */
  let root;
  try {
    root = parseXmlDocumentForC14n(decodedXml);
  } catch {
    throw makeXmlDsigTamperedError();
  }

  const sigElem =
    findDirectChildElement(root, 'Signature', XMLDSIG_NS) ||
    findDescendantElement(root, 'Signature', XMLDSIG_NS);
  if (!sigElem || !sigElem.parent) {
    return false;
  }

  const signedInfoElem = findDirectChildElement(sigElem, 'SignedInfo', XMLDSIG_NS);
  const sigValElem = findDirectChildElement(sigElem, 'SignatureValue', XMLDSIG_NS);
  const rsaKeyValElem = findDescendantElement(sigElem, 'RSAKeyValue', XMLDSIG_NS);
  const modulusElem = rsaKeyValElem
    ? findDirectChildElement(rsaKeyValElem, 'Modulus', XMLDSIG_NS)
    : null;
  const exponentElem = rsaKeyValElem
    ? findDirectChildElement(rsaKeyValElem, 'Exponent', XMLDSIG_NS)
    : null;
  const refElem = signedInfoElem
    ? findDirectChildElement(signedInfoElem, 'Reference', XMLDSIG_NS)
    : null;
  const digestValElem = refElem
    ? findDirectChildElement(refElem, 'DigestValue', XMLDSIG_NS)
    : null;

  if (!signedInfoElem || !sigValElem || !modulusElem || !exponentElem || !refElem || !digestValElem) {
    throw makeXmlDsigTamperedError();
  }

  // Enforce strict SHA-256 + RSA-SHA256 algorithm allowlist (preventing downgrade / confusion)
  const sigMethodElem = findDirectChildElement(signedInfoElem, 'SignatureMethod', XMLDSIG_NS);
  const sigAlg = sigMethodElem?.attrs.find((a) => a.localName === 'Algorithm')?.value || '';
  const digestMethodElem = findDirectChildElement(refElem, 'DigestMethod', XMLDSIG_NS);
  const digestAlg = digestMethodElem?.attrs.find((a) => a.localName === 'Algorithm')?.value || '';
  const refUri = refElem.attrs.find((a) => a.localName === 'URI')?.value ?? '';
  if (sigAlg !== XMLDSIG_RSA_SHA256_URI || digestAlg !== XMLENC_SHA256_URI || refUri !== '') {
    throw makeXmlDsigTamperedError();
  }

  // 1. Enveloped-Signature Transform + C14N over `<License>` (with `<Signature>` stripped) -> SHA-256
  let refUseExclusive = false;
  /** @type {Set<string> | undefined} */
  let refInclusivePrefixes;
  const transformsElem = findDirectChildElement(refElem, 'Transforms', XMLDSIG_NS);
  if (transformsElem) {
    for (const child of transformsElem.children) {
      if (child.type !== 'element' || child.localName !== 'Transform') continue;
      const tAlg = child.attrs.find((a) => a.localName === 'Algorithm')?.value || '';
      if (tAlg.includes('xml-exc-c14n')) {
        refUseExclusive = true;
        const incNs = findDirectChildElement(child, 'InclusiveNamespaces', XML_EXC_C14N_NS);
        const pfxList = incNs?.attrs.find((a) => a.localName === 'PrefixList')?.value || '';
        if (pfxList.trim()) {
          refInclusivePrefixes = new Set(pfxList.trim().split(/\s+/));
        }
      }
    }
  }

  const targetLicenseElem = sigElem.parent;
  const c14nLicenseWithoutSig = serializeC14nNode(targetLicenseElem, {
    exclusive: refUseExclusive,
    inclusivePrefixes: refInclusivePrefixes,
    skipElement: sigElem,
  });
  const computedDigest = crypto.createHash('sha256').update(c14nLicenseWithoutSig, 'utf8').digest();
  const expectedDigestB64 = collectElementText(digestValElem).replace(/\s+/g, '');
  const expectedDigest = expectedDigestB64 ? Buffer.from(expectedDigestB64, 'base64') : Buffer.alloc(0);
  if (
    expectedDigest.length !== computedDigest.length ||
    !crypto.timingSafeEqual(computedDigest, expectedDigest)
  ) {
    throw makeXmlDsigTamperedError();
  }

  // 2. Exclusive C14N (`xml-exc-c14n#`) over `<SignedInfo>` -> RSA-SHA256 verification
  const c14nMethodElem = findDirectChildElement(signedInfoElem, 'CanonicalizationMethod', XMLDSIG_NS);
  const c14nAlg =
    c14nMethodElem?.attrs.find((a) => a.localName === 'Algorithm')?.value || XML_EXC_C14N_NS;
  const signedInfoUseExclusive = c14nAlg.includes('xml-exc-c14n');
  /** @type {Set<string> | undefined} */
  let signedInfoInclusivePrefixes;
  if (signedInfoUseExclusive && c14nMethodElem) {
    const incNs = findDirectChildElement(c14nMethodElem, 'InclusiveNamespaces', XML_EXC_C14N_NS);
    const pfxList = incNs?.attrs.find((a) => a.localName === 'PrefixList')?.value || '';
    if (pfxList.trim()) {
      signedInfoInclusivePrefixes = new Set(pfxList.trim().split(/\s+/));
    }
  }
  const c14nSignedInfo = serializeC14nNode(signedInfoElem, {
    exclusive: signedInfoUseExclusive,
    inclusivePrefixes: signedInfoInclusivePrefixes,
  });

  const modB64 = collectElementText(modulusElem).replace(/\s+/g, '');
  const expB64 = collectElementText(exponentElem).replace(/\s+/g, '');
  const sigB64 = collectElementText(sigValElem).replace(/\s+/g, '');
  if (!modB64 || !expB64 || !sigB64) {
    throw makeXmlDsigTamperedError();
  }

  const modulusBuf = Buffer.from(modB64, 'base64');
  const exponentBuf = Buffer.from(expB64, 'base64');
  const signatureBuf = Buffer.from(sigB64, 'base64');
  if (modulusBuf.length < 64 || exponentBuf.length === 0 || signatureBuf.length === 0) {
    throw makeXmlDsigTamperedError();
  }

  let rsaVerified = false;
  try {
    const publicKey = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: toUnsignedBase64Url(modulusBuf),
        e: toUnsignedBase64Url(exponentBuf),
      },
      format: 'jwk',
    });
    rsaVerified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(c14nSignedInfo, 'utf8'),
      publicKey,
      signatureBuf
    );
  } catch {
    throw makeXmlDsigTamperedError();
  }

  if (!rsaVerified) {
    throw makeXmlDsigTamperedError();
  }

  return true;
}

/**
 * Parses a binary `<SPLicenseBlock>` TLV buffer.
 * Header: 8 bytes (`u32 LE` magic/version + `u32 LE` offset), followed by `[blockId: u32 LE, size: u32 LE, value[size]]`.
 *
 * @param {Buffer} buf
 * @param {{ verifyCmacWithKey?: Buffer | null, requireCmacSignature?: boolean, allowUnsigned?: boolean }} [options]
 */
function parseSpLicenseBuffer(buf, options = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) {
    throw new Error(`SPLicense buffer too short (${buf?.length || 0} bytes)`);
  }

  const headerMagic = buf.readUInt32LE(0);
  const headerOffset = buf.readUInt32LE(4);

  const blocks = [];
  let deviceKeyBuffer = null;
  let clepRsaKeyPem = null;
  let licenseId = null;
  let packageFullName = null;
  const packedContentKeys = [];
  let cmacBlockOffset = -1;
  let cmacTag = null;
  let signatureBlockOffset = -1;
  let signatureBlock = null;

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const blockStartOffset = offset;
    const blockId = buf.readUInt32LE(offset);
    const size = buf.readUInt32LE(offset + 4);
    const valueStart = offset + 8;
    const valueEnd = valueStart + size;
    if (valueEnd > buf.length) {
      break;
    }
    const payload = buf.subarray(valueStart, valueEnd);
    blocks.push({ blockId, size, offset: blockStartOffset, payload });

    if (blockId === BLOCK_ID.ENCRYPTED_DEVICE_KEY && payload.length >= 534) {
      // EncryptedDeviceKey: u16 size (0..2), u32 version (2..6), key_schedule u32[58] (6..238),
      // _unknown1[280] (238..518), device_key[16] (518..534)
      const scheduleKey = deriveClepKeyFromSchedule(payload.subarray(6, 238));
      const encDeviceKey = payload.subarray(518, 534);
      deviceKeyBuffer = decryptCbcZeroIv(scheduleKey, encDeviceKey);
    } else if (blockId === BLOCK_ID.CLEP_SIGN_STATE && payload.length >= 780) {
      // ClepSignState: u32 version (0..4), key_data[544] (4..548), key_schedule u32[58] (548..780)
      const scheduleKey = deriveClepKeyFromSchedule(payload.subarray(548, 780));
      const decryptedRsaBlob = decryptCbcZeroIv(scheduleKey, payload.subarray(4, 548));
      clepRsaKeyPem = parseBcryptRsaPrivateKeyToPem(decryptedRsaBlob);
    } else if (blockId === BLOCK_ID.PACKED_CONTENT_KEYS && payload.length >= 4) {
      let pkOff = 0;
      while (pkOff + 4 <= payload.length) {
        const idLen = payload.readUInt16LE(pkOff);
        const keyLen = payload.readUInt16LE(pkOff + 2);
        const entryEnd = pkOff + 4 + idLen + keyLen;
        if (idLen < 16 || keyLen <= 0 || entryEnd > payload.length) break;
        const rawGuid16 = Buffer.from(payload.subarray(pkOff + 4, pkOff + 20));
        const keyId = formatMixedEndianGuid(rawGuid16);
        const wrappedCik = Buffer.from(payload.subarray(pkOff + 4 + idLen, entryEnd));
        packedContentKeys.push({
          keyId,
          keyIdRaw: rawGuid16,
          wrappedCik,
        });
        pkOff = entryEnd;
      }
    } else if (blockId === BLOCK_ID.LICENSE_ID && payload.length >= 16) {
      licenseId = formatMixedEndianGuid(payload.subarray(0, 16));
    } else if (blockId === BLOCK_ID.PACKAGE_FULL_NAME && payload.length >= 2) {
      packageFullName = payload
        .toString('utf16le')
        .replace(/\0+$/g, '')
        .trim();
    } else if (blockId === BLOCK_ID.CMAC_SIGNATURE) {
      cmacBlockOffset = blockStartOffset;
      cmacTag =
        payload.length >= 16
          ? Buffer.from(payload.subarray(payload.length - 16))
          : Buffer.from(payload);
    } else if (blockId === BLOCK_ID.SIGNATURE_BLOCK) {
      signatureBlockOffset = blockStartOffset;
      signatureBlock =
        payload.length >= 4
          ? {
              algorithmId: payload.readUInt16LE(0),
              signatureOrigin: payload.readUInt16LE(2),
              signature: Buffer.from(payload.subarray(4)),
            }
          : {
              algorithmId: 0,
              signatureOrigin: 0,
              signature: Buffer.alloc(0),
            };
    }

    offset = valueEnd;
  }

  let cmacVerified = false;
  let serverSignaturePresent = false;
  /** @type {'cmac-0x0101' | 'server-0x00cc' | 'unsigned'} */
  let signatureType = 'unsigned';

  if (cmacTag !== null || options.requireCmacSignature === true) {
    if (!cmacTag || cmacBlockOffset < 8) {
      throw Object.assign(
        new Error('SPLicense missing required AES-CMAC signature tag (0x0101)'),
        { code: 'SPLICENSE_UNSIGNED' }
      );
    }

    const cmacKey = Buffer.isBuffer(options.verifyCmacWithKey)
      ? options.verifyCmacWithKey
      : deviceKeyBuffer;
    if (!Buffer.isBuffer(cmacKey) || cmacKey.length !== 16) {
      throw Object.assign(
        new Error('SPLicense missing required AES-CMAC signature tag (0x0101) verification key'),
        { code: 'SPLICENSE_CMAC_TAMPERED' }
      );
    }

    const signedSlice = buf.subarray(0, cmacBlockOffset);
    const expected = aes128Cmac(cmacKey, signedSlice);
    const validCmac = cmacTag.length === 16 && crypto.timingSafeEqual(expected, cmacTag);
    if (!validCmac) {
      throw Object.assign(
        new Error('SPLicense AES-128-CMAC verification failed for signature tag (0x0101)'),
        { code: 'SPLICENSE_CMAC_TAMPERED' }
      );
    }

    cmacVerified = true;
    serverSignaturePresent = Boolean(signatureBlock);
    signatureType = 'cmac-0x0101';
  } else if (signatureBlock !== null) {
    const validServerSig =
      headerMagic === 0x00000014 &&
      signatureBlockOffset >= 8 &&
      (8 + headerOffset === signatureBlockOffset || 8 + headerOffset === buf.length) &&
      signatureBlock.algorithmId === 1 &&
      signatureBlock.signature.length === 64 &&
      signatureBlock.signature.some((b) => b !== 0);
    if (!validServerSig) {
      throw Object.assign(
        new Error('SPLicense malformed server SIGNATURE_BLOCK (0x00cc)'),
        { code: 'SPLICENSE_SIGNATURE_TAMPERED' }
      );
    }

    cmacVerified = false;
    serverSignaturePresent = true;
    signatureType = 'server-0x00cc';
  } else if (options.allowUnsigned === true) {
    cmacVerified = false;
    serverSignaturePresent = false;
    signatureType = 'unsigned';
  } else {
    throw Object.assign(
      new Error(
        'SPLicense missing required signature tag (expected 0x0101 AES-CMAC or 0x00cc SIGNATURE_BLOCK)'
      ),
      { code: 'SPLICENSE_UNSIGNED' }
    );
  }

  return {
    headerMagic,
    headerOffset,
    blocks,
    deviceKeyBuffer,
    clepRsaKeyPem,
    licenseId,
    packageFullName,
    packedContentKeys,
    cmacTag,
    cmacVerified,
    signatureBlock,
    serverSignaturePresent,
    signatureType,
  };
}

/**
 * Parses an `<SPLicenseBlock>` payload (raw Base64 TLV, `<License>` XML, or Base64-encoded `<License>` XML),
 * verifying any enveloped W3C XML-DSig `RSA-SHA256` signature unless `options.verifyXmlSignature === false`.
 *
 * @param {string} rawXmlOrBase64
 * @param {{
 *   verifyCmacWithKey?: Buffer | null,
 *   requireCmacSignature?: boolean,
 *   allowUnsigned?: boolean,
 *   verifyXmlSignature?: boolean,
 * }} [options]
 */
function parseSpLicenseBase64(rawXmlOrBase64, options = {}) {
  const decodedXml = decodeSpLicenseXmlIfPresent(rawXmlOrBase64);
  let xmlSignatureVerified = false;
  if (decodedXml !== null && options.verifyXmlSignature !== false) {
    xmlSignatureVerified = verifyLicenseXmlDsigIfPresent(decodedXml);
  }

  const b64Blocks = extractAllSpLicenseBase64Blocks(
    decodedXml !== null ? decodedXml : rawXmlOrBase64
  );
  if (b64Blocks.length === 0) {
    throw new Error('Empty SPLicense payload');
  }
  const parsedList = b64Blocks.map((b64) => parseSpLicenseBuffer(Buffer.from(b64, 'base64'), options));
  if (parsedList.length === 1) {
    return {
      ...parsedList[0],
      xmlSignatureVerified,
    };
  }

  const first = parsedList[0];
  const mergedBlocks = [];
  const mergedPackedContentKeys = [];
  let deviceKeyBuffer = null;
  let clepRsaKeyPem = null;
  let licenseId = null;
  let packageFullName = null;
  let cmacTag = null;
  /** @type {boolean | null} */
  let cmacVerified = null;
  let signatureBlock = null;
  let serverSignaturePresent = false;
  /** @type {'cmac-0x0101' | 'server-0x00cc' | 'unsigned'} */
  let signatureType = first.signatureType;

  for (const p of parsedList) {
    mergedBlocks.push(...p.blocks);
    mergedPackedContentKeys.push(...p.packedContentKeys);
    if (!deviceKeyBuffer && p.deviceKeyBuffer) deviceKeyBuffer = p.deviceKeyBuffer;
    if (!clepRsaKeyPem && p.clepRsaKeyPem) clepRsaKeyPem = p.clepRsaKeyPem;
    if (!licenseId && p.licenseId) licenseId = p.licenseId;
    if (!packageFullName && p.packageFullName) packageFullName = p.packageFullName;
    if (!cmacTag && p.cmacTag) cmacTag = p.cmacTag;
    if (p.cmacVerified !== null) {
      cmacVerified = cmacVerified === null ? p.cmacVerified : cmacVerified && p.cmacVerified;
    }
    if (!signatureBlock && p.signatureBlock) signatureBlock = p.signatureBlock;
    if (p.serverSignaturePresent) serverSignaturePresent = true;
    if (p.signatureType === 'cmac-0x0101') signatureType = 'cmac-0x0101';
    else if (signatureType === 'unsigned' && p.signatureType === 'server-0x00cc') {
      signatureType = 'server-0x00cc';
    }
  }

  return {
    headerMagic: first.headerMagic,
    headerOffset: first.headerOffset,
    blocks: mergedBlocks,
    deviceKeyBuffer,
    clepRsaKeyPem,
    licenseId,
    packageFullName,
    packedContentKeys: mergedPackedContentKeys,
    cmacTag,
    cmacVerified: Boolean(cmacVerified),
    signatureBlock,
    serverSignaturePresent,
    signatureType,
    xmlSignatureVerified,
  };
}

// ============================================================================
// 3. NIST SP 800-108 Counter KDF, Exclusive XML-DSig & `RST2.srf` Device STS
// ============================================================================

/**
 * NIST SP 800-108 Counter Mode KDF using `HMAC-SHA256`:
 * `[i]_32BE || Label || 0x00 || Context || [L_bits]_32BE`.
 * Exact port of `generate_shared_key` in `api/live/utils.rs`.
 *
 * @param {number} keyLengthBytes
 * @param {Buffer} inKey
 * @param {string} keyUsage
 * @param {Buffer} context
 * @returns {Buffer}
 */
function generateSp800108SharedKey(keyLengthBytes, inKey, keyUsage, context) {
  const usageBuf = Buffer.from(String(keyUsage || ''), 'utf8');
  const ctxBuf = Buffer.isBuffer(context) ? context : Buffer.from(context || '');
  const material = Buffer.alloc(4 + usageBuf.length + 1 + ctxBuf.length + 4, 0);

  usageBuf.copy(material, 4);
  ctxBuf.copy(material, 4 + usageBuf.length + 1);
  material.writeUInt32BE((keyLengthBytes * 8) >>> 0, 4 + usageBuf.length + 1 + ctxBuf.length);

  const out = Buffer.alloc(keyLengthBytes);
  let written = 0;
  let counter = 1;
  while (written < keyLengthBytes) {
    material.writeUInt32BE(counter >>> 0, 0);
    counter += 1;
    const digest = crypto.createHmac('sha256', inKey).update(material).digest();
    const take = Math.min(digest.length, keyLengthBytes - written);
    digest.copy(out, written, 0, take);
    written += take;
  }
  return out;
}

/**
 * Derives the `urn:liveid:SP800108_CTR_HMAC_SHA256_DOUBLEDERIVED` signing/encryption key.
 *
 * @param {Buffer} clepHmacSecret 32-byte secret unwrapped from `ClepHmacState`
 * @param {Buffer} nonce 32-byte random or response nonce
 * @param {Buffer} [tpmSecret] optional TPM secret (empty when TPM disabled)
 * @returns {Buffer} 32-byte key
 */
function deriveDoubleDerivedHmacKey(clepHmacSecret, nonce, tpmSecret) {
  const first = generateSp800108SharedKey(32, clepHmacSecret, HMAC_KEY_USAGE, nonce);
  if (Buffer.isBuffer(tpmSecret) && tpmSecret.length > 0) {
    return generateSp800108SharedKey(32, tpmSecret, HMAC_KEY_USAGE, first);
  }
  return first;
}

/**
 * Unwraps the 32-byte `clepHmacSecret` from a 4096-byte `ClepHmacState` (`BinarySecret` returned by
 * `RST2.srf` device authentication):
 * `version: u32 (0..4)`, `key_data[48] (4..52)`, `key_schedule: u32[58] (52..284)`.
 * Decrypted `key_data[12..44]` is the 32-byte HMAC secret.
 *
 * @param {Buffer | string} binarySecretBufOrB64
 * @returns {Buffer} 32-byte HMAC secret
 */
function unwrapClepHmacStateSecret(binarySecretBufOrB64) {
  const buf = Buffer.isBuffer(binarySecretBufOrB64)
    ? binarySecretBufOrB64
    : Buffer.from(String(binarySecretBufOrB64 || '').trim(), 'base64');
  if (buf.length < 284) {
    throw new Error(`ClepHmacState BinarySecret too short (${buf.length} bytes)`);
  }
  const scheduleKey = deriveClepKeyFromSchedule(buf.subarray(52, 284));
  const decrypted48 = decryptCbcZeroIv(scheduleKey, buf.subarray(4, 52));
  return Buffer.from(decrypted48.subarray(12, 44));
}

function escapeXmlText(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

function escapeXmlAttr(str) {
  return escapeXmlText(str)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;');
}

function decodeXmlEntities(str) {
  return String(str ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function generateNumericDeviceMembername() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(14);
  let out = '02';
  for (let i = 0; i < 14; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function generateDevicePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^*_-+=';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function buildDeviceAddCredentialXml({ membername, password, clepV2B64, clepV4B64 }) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<DeviceAddRequest>` +
    `<ClientInfo name="IDCRL" version="1.0"><BinaryVersion>55</BinaryVersion></ClientInfo>` +
    `<Authentication>` +
    `<Membername>${escapeXmlText(membername)}</Membername>` +
    `<Password>${escapeXmlText(password)}</Password>` +
    `</Authentication>` +
    `<DeviceInfo Id="DeviceInfo">` +
    `<Component name="4113">AA==</Component>` +
    `<Component name="4101" error="-2147024894"/>` +
    `<Component name="8196">${escapeXmlText(clepV2B64)}</Component>` +
    `<Component name="8197">${escapeXmlText(clepV4B64)}</Component>` +
    `<Component name="4102" error="-2147024894"/>` +
    `<Component name="4103" error="-2147024894"/>` +
    `<Component name="4104" error="-2147024894"/>` +
    `<Component name="4145">AQAAAA==</Component>` +
    `<Component name="4160" error="-2147024894"/>` +
    `<Component name="4161" error="-2147024894"/>` +
    `</DeviceInfo>` +
    `</DeviceAddRequest>`
  );
}

/**
 * Builds an Exclusive XML-C14N (`http://www.w3.org/2001/10/xml-exc-c14n#`) signed `RST2.srf` SOAP
 * envelope where `#RST0` (or `#RSTS`), `#Timestamp`, `#PPAuthInfo`, and `<SignedInfo>` are emitted
 * directly in exact W3C Exclusive Canonical Form so their SHA-256 digests and XML-DSig signature
 * verify cleanly against `https://login.live.com:443/RST2.srf`.
 *
 * @param {Record<string, any>} params
 */
function buildSignedRst2SoapEnvelope({
  authBlockXml = '',
  hostingApp = HOSTING_APP_DEFAULT_IDCRL,
  ssoFlags = '',
  inlineUx = 'TokenBroker',
  inlineFt = '',
  licenseSignatureKeyVersion = '2',
  scopeAddress,
  policy,
  scopes,
  signingMode, // 'rsa' | 'hmac'
  rsaPrivateKeyPem,
  clepHmacSecret,
  tpmSecret,
  derivedKeyRefUri = '',
  legacyTokenIdRef,
  nowMs = Date.now(),
}) {
  const nowSec = Math.floor(nowMs / 1000);
  const createdIso = new Date(nowSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiresIso = new Date((nowSec + 300) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Canonical `#Timestamp` (Exclusive C14N: xmlns:wsu declared on wsu:Timestamp)
  const canonicalTimestamp =
    `<wsu:Timestamp xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" wsu:Id="Timestamp">` +
    `<wsu:Created>${createdIso}</wsu:Created>` +
    `<wsu:Expires>${expiresIso}</wsu:Expires>` +
    `</wsu:Timestamp>`;

  // Canonical `#PPAuthInfo` (Exclusive C14N: xmlns:ps declared on ps:AuthInfo)
  const licSigVerXml =
    licenseSignatureKeyVersion !== null && licenseSignatureKeyVersion !== undefined && licenseSignatureKeyVersion !== ''
      ? `<ps:LicenseSignatureKeyVersion>${escapeXmlText(licenseSignatureKeyVersion)}</ps:LicenseSignatureKeyVersion>`
      : '';
  const inlineFtXml = inlineFt ? `<ps:InlineFT>${escapeXmlText(inlineFt)}</ps:InlineFT>` : '';

  const canonicalAuthInfo =
    `<ps:AuthInfo xmlns:ps="http://schemas.microsoft.com/Passport/SoapServices/PPCRL" Id="PPAuthInfo">` +
    `<ps:SSOFlags>${escapeXmlText(ssoFlags)}</ps:SSOFlags>` +
    `<ps:HostingApp>${escapeXmlText(hostingApp)}</ps:HostingApp>` +
    `<ps:BinaryVersion>55</ps:BinaryVersion>` +
    `<ps:UIVersion>1</ps:UIVersion>` +
    `<ps:InlineUX>${escapeXmlText(inlineUx)}</ps:InlineUX>` +
    `<ps:IsAdmin>1</ps:IsAdmin>` +
    `<ps:Cookies></ps:Cookies>` +
    `<ps:RequestParams>AQAAAAIAAABsYwQAAAAxMDMz</ps:RequestParams>` +
    `<ps:WindowsClientString>b4d/QB7Zy5pjUAY9ByQ1echTyTITx6ZCErOEztuIVtw=</ps:WindowsClientString>` +
    licSigVerXml +
    `<ps:ClientCapabilities>1</ps:ClientCapabilities>` +
    inlineFtXml +
    `</ps:AuthInfo>`;

  const normalizedScopes =
    Array.isArray(scopes) && scopes.length > 0
      ? scopes
      : [{ scopeAddress: scopeAddress || 'http://Passport.NET/tb', policy: policy || '' }];

  const buildSingleRst = (item, idx) => {
    const polXml = item.policy
      ? `<wsp:PolicyReference xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy" URI="${escapeXmlAttr(item.policy)}"></wsp:PolicyReference>`
      : '';
    return (
      `<wst:RequestSecurityToken xmlns:wst="http://schemas.xmlsoap.org/ws/2005/02/trust" Id="RST${idx}">` +
      `<wst:RequestType>http://schemas.xmlsoap.org/ws/2005/02/trust/Issue</wst:RequestType>` +
      `<wsp:AppliesTo xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy">` +
      `<wsa:EndpointReference xmlns:wsa="http://www.w3.org/2005/08/addressing">` +
      `<wsa:Address>${escapeXmlText(item.scopeAddress)}</wsa:Address>` +
      `</wsa:EndpointReference>` +
      `</wsp:AppliesTo>` +
      polXml +
      `</wst:RequestSecurityToken>`
    );
  };

  const isMultiScope = normalizedScopes.length > 1;
  const canonicalBodyTarget = isMultiScope
    ? `<ps:RequestMultipleSecurityTokens xmlns:ps="http://schemas.microsoft.com/Passport/SoapServices/PPCRL" Id="RSTS">` +
      normalizedScopes.map((s, idx) => buildSingleRst(s, idx)).join('') +
      `</ps:RequestMultipleSecurityTokens>`
    : buildSingleRst(normalizedScopes[0], 0);
  const bodyRefUri = isMultiScope ? '#RSTS' : '#RST0';

  const digestBody = crypto.createHash('sha256').update(canonicalBodyTarget, 'utf8').digest('base64');
  const digestTs = crypto.createHash('sha256').update(canonicalTimestamp, 'utf8').digest('base64');
  const digestAuthInfo = crypto.createHash('sha256').update(canonicalAuthInfo, 'utf8').digest('base64');

  const sigAlg =
    signingMode === 'rsa'
      ? 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
      : 'http://www.w3.org/2001/04/xmldsig-more#hmac-sha256';

  const makeRef = (uri, digestB64) =>
    `<Reference URI="${uri}">` +
    `<Transforms><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></Transform></Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></DigestMethod>` +
    `<DigestValue>${digestB64}</DigestValue>` +
    `</Reference>`;

  const canonicalSignedInfo =
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${sigAlg}"></SignatureMethod>` +
    makeRef(bodyRefUri, digestBody) +
    makeRef('#Timestamp', digestTs) +
    makeRef('#PPAuthInfo', digestAuthInfo) +
    `</SignedInfo>`;

  let signatureValueB64 = '';
  let derivedKeyTokenXml = '';
  let keyInfoXml = '';

  if (signingMode === 'rsa') {
    signatureValueB64 = crypto
      .sign('RSA-SHA256', Buffer.from(canonicalSignedInfo, 'utf8'), rsaPrivateKeyPem)
      .toString('base64');
  } else {
    const nonce = crypto.randomBytes(32);
    const hmacKey = deriveDoubleDerivedHmacKey(clepHmacSecret, nonce, tpmSecret);
    signatureValueB64 = crypto
      .createHmac('sha256', hmacKey)
      .update(canonicalSignedInfo, 'utf8')
      .digest('base64');

    const resolvedRefUri =
      derivedKeyRefUri !== undefined
        ? String(derivedKeyRefUri)
        : legacyTokenIdRef
          ? String(legacyTokenIdRef)
          : '';

    derivedKeyTokenXml =
      `<wssc:DerivedKeyToken wsu:Id="SignKey" Algorithm="urn:liveid:SP800108_CTR_HMAC_SHA256_DOUBLEDERIVED">` +
      `<wsse:RequestedTokenReference>` +
      `<wsse:KeyIdentifier ValueType="http://docs.oasis-open.org/wss/2004/XX/oasis-2004XX-wss-saml-token-profile-1.0#SAMLAssertionID"></wsse:KeyIdentifier>` +
      `<wsse:Reference URI="${escapeXmlAttr(resolvedRefUri)}"></wsse:Reference>` +
      `</wsse:RequestedTokenReference>` +
      `<wssc:Nonce>${nonce.toString('base64')}</wssc:Nonce>` +
      `</wssc:DerivedKeyToken>`;

    keyInfoXml =
      `<KeyInfo>` +
      `<wsse:SecurityTokenReference>` +
      `<wsse:Reference URI="#SignKey"></wsse:Reference>` +
      `</wsse:SecurityTokenReference>` +
      `</KeyInfo>`;
  }

  const signatureXml =
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    canonicalSignedInfo +
    `<SignatureValue>${signatureValueB64}</SignatureValue>` +
    keyInfoXml +
    `</Signature>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:ps="http://schemas.microsoft.com/Passport/SoapServices/PPCRL" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:saml="urn:oasis:names:tc:SAML:1.0:assertion" xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wsa="http://www.w3.org/2005/08/addressing" xmlns:wssc="http://schemas.xmlsoap.org/ws/2005/02/sc" xmlns:wst="http://schemas.xmlsoap.org/ws/2005/02/trust">` +
    `<s:Header>` +
    `<wsa:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/02/trust/RST/Issue</wsa:Action>` +
    `<wsa:To s:mustUnderstand="1">https://login.live.com:443/RST2.srf</wsa:To>` +
    `<wsa:MessageID>${nowSec}</wsa:MessageID>` +
    canonicalAuthInfo +
    `<wsse:Security>` +
    authBlockXml +
    derivedKeyTokenXml +
    canonicalTimestamp +
    signatureXml +
    `</wsse:Security>` +
    `</s:Header>` +
    `<s:Body>` +
    canonicalBodyTarget +
    `</s:Body>` +
    `</s:Envelope>`
  );
}

function extractDerivedKeyNoncesMap(soapXml) {
  const nonces = new Map();
  const dktRegex = /<(?:[\w-]+:)?DerivedKeyToken\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?DerivedKeyToken>/gi;
  let m;
  while ((m = dktRegex.exec(String(soapXml || ''))) !== null) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const idMatch = attrs.match(/\b(?:[\w-]+:)?Id="([^"]+)"/i);
    const nonceMatch = inner.match(/<(?:[\w-]+:)?Nonce[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Nonce>/i);
    if (idMatch && nonceMatch) {
      nonces.set(idMatch[1].trim(), nonceMatch[1].replace(/\s+/g, ''));
    }
  }
  return nonces;
}

function decryptSingleEncryptedDataElement(encDataXml, nonces, clepHmacSecret) {
  if (!encDataXml || !Buffer.isBuffer(clepHmacSecret)) return null;
  const cipherMatch = encDataXml.match(/<(?:[\w-]+:)?CipherValue[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?CipherValue>/i);
  if (!cipherMatch || !cipherMatch[1]) return null;

  const refMatch = encDataXml.match(/<(?:[\w-]+:)?Reference\b[^>]*\bURI="#?([^"]+)"/i);
  const targetId = refMatch ? refMatch[1].trim() : Array.from(nonces.keys())[0];
  const nonceB64 = targetId ? nonces.get(targetId) : null;
  if (!nonceB64) return null;

  const nonceBuf = Buffer.from(nonceB64, 'base64');
  const aesKey32 = deriveDoubleDerivedHmacKey(clepHmacSecret, nonceBuf);
  const cipherPayload = Buffer.from(cipherMatch[1].replace(/\s+/g, ''), 'base64');
  if (cipherPayload.length <= 16 || cipherPayload.length % 16 !== 0) {
    throw new Error('Invalid EncryptedData CipherValue length');
  }

  const iv = cipherPayload.subarray(0, 16);
  const encrypted = cipherPayload.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey32, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Decrypts both `<psf:EncryptedPP>` (in `<s:Header>`) and `<EncryptedData>` (in `<s:Body>`)
 * independently so header `<psf:EncryptedPP>` never shadows the `<s:Body>` token payload.
 *
 * @param {string} soapXml
 * @param {Buffer} clepHmacSecret
 * @returns {{ decryptedPpXml: string | null, decryptedBodyXml: string | null, rawBodyXml: string }}
 */
function decryptRst2SoapEnvelope(soapXml, clepHmacSecret) {
  const xml = String(soapXml || '');
  const nonces = extractDerivedKeyNoncesMap(xml);

  let decryptedPpXml = null;
  const encPpMatch = xml.match(/<(?:[\w-]+:)?EncryptedPP\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?EncryptedPP>/i);
  if (encPpMatch && encPpMatch[1]) {
    const ppEncData = encPpMatch[1].match(/<(?:[\w-]+:)?EncryptedData\b[\s\S]*?<\/(?:[\w-]+:)?EncryptedData>/i);
    if (ppEncData) {
      try {
        decryptedPpXml = decryptSingleEncryptedDataElement(ppEncData[0], nonces, clepHmacSecret);
      } catch {}
    }
  }

  const bodyMatch = xml.match(/<(?:[\w-]+:)?Body\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Body>/i);
  const rawBodyXml = bodyMatch ? bodyMatch[1] : xml;
  let decryptedBodyXml = null;

  const bodyWithoutPp = bodyMatch
    ? rawBodyXml
    : xml.replace(/<(?:[\w-]+:)?EncryptedPP\b[\s\S]*?<\/(?:[\w-]+:)?EncryptedPP>/gi, '');
  const bodyEncData = bodyWithoutPp.match(
    /<(?:[\w-]+:)?EncryptedData\b[\s\S]*?<\/(?:[\w-]+:)?EncryptedData>/i
  );
  if (bodyEncData) {
    decryptedBodyXml = decryptSingleEncryptedDataElement(bodyEncData[0], nonces, clepHmacSecret);
  }

  return {
    decryptedPpXml,
    decryptedBodyXml,
    rawBodyXml,
  };
}

/**
 * Decrypts a WS-Security `<EncryptedData>` `<CipherValue>` (`iv[16] || AES-256-CBC-PKCS7(plaintext)`)
 * using the `DerivedKeyToken` `<Nonce>` and `clepHmacSecret`, prioritizing `<s:Body>` over `<psf:EncryptedPP>`.
 *
 * @param {string} soapXml
 * @param {Buffer} clepHmacSecret
 * @returns {string | null}
 */
function decryptRst2EncryptedDataXml(soapXml, clepHmacSecret) {
  const { decryptedBodyXml, decryptedPpXml } = decryptRst2SoapEnvelope(soapXml, clepHmacSecret);
  return decryptedBodyXml || decryptedPpXml || null;
}

function extractXmlTagText(xml, localTagName) {
  const re = new RegExp(`<(?:[\\w-]+:)?${localTagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${localTagName}>`, 'i');
  const m = String(xml || '').match(re);
  return m && m[1] ? decodeXmlEntities(m[1].trim()) : '';
}

function extractCompactBinarySecurityToken(xml) {
  const bstMatch = String(xml || '').match(
    /<(?:[\w-]+:)?BinarySecurityToken\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?BinarySecurityToken>/i
  );
  if (!bstMatch || !bstMatch[1]) return '';
  return decodeXmlEntities(bstMatch[1].trim());
}

/**
 * Parses one or more `<RequestSecurityTokenResponse>` blocks from a decrypted `RST2.srf` `<s:Body>`.
 */
function parseRst2TokenResponses(bodyXml) {
  const tokens = [];
  const rstrRegex =
    /<(?:[\w-]+:)?RequestSecurityTokenResponse\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?RequestSecurityTokenResponse>/gi;
  let m;
  while ((m = rstrRegex.exec(String(bodyXml || ''))) !== null) {
    const block = m[1] || '';
    const tokenType = extractXmlTagText(block, 'TokenType');
    const scopeAddress = extractXmlTagText(block, 'Address');
    const created = extractXmlTagText(block, 'Created');
    const expires = extractXmlTagText(block, 'Expires');
    const binarySecretB64 = extractXmlTagText(block, 'BinarySecret');
    const rawCompact = extractCompactBinarySecurityToken(block);
    const encDataMatch = block.match(
      /<(?:[\w-]+:)?EncryptedData\b[\s\S]*?<\/(?:[\w-]+:)?EncryptedData>/i
    );
    const legacyTokenXml = encDataMatch ? encDataMatch[0] : '';
    const keyName = legacyTokenXml ? extractXmlTagText(legacyTokenXml, 'KeyName') : '';

    let compactToken = '';
    if (rawCompact) {
      compactToken = tokenType === 'urn:passport:delegationcompact' ? `d=${rawCompact}` : rawCompact;
    }

    tokens.push({
      scopeAddress,
      tokenType,
      compactToken,
      legacyTokenXml,
      binarySecretB64,
      keyName,
      created,
      expires,
    });
  }
  return tokens;
}

/**
 * Exchanges a user `LegacyToken` (`DAProperty.sDAToken` from `InlineLogin.srf` or saved
 * `http://Passport.NET/STS` `userStsLegacyTokenXml`) + virtual Windows `deviceLegacyTokenXml`
 * against `https://login.live.com/RST2.srf`.
 *
 * @param {{
 *   userLegacyTokenXml: string,
 *   username?: string,
 *   deviceLegacyTokenXml: string,
 *   clepHmacSecret: Buffer,
 *   inlineFt?: string,
 *   inlineUx?: string,
 *   hostingApp?: string,
 *   scopes?: Array<{ scopeAddress: string, policy: string }>,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 * }} params
 */
async function exchangeUserTokenOnRst2({
  userLegacyTokenXml,
  username,
  deviceLegacyTokenXml,
  clepHmacSecret,
  inlineFt = '',
  inlineUx = 'TokenBroker',
  hostingApp = HOSTING_APP_MS_STORE,
  scopes = [{ scopeAddress: 'www.microsoft.com', policy: 'mbi_ssl' }],
  fetchImpl = globalThis.fetch,
  signal,
}) {
  if (!userLegacyTokenXml || !deviceLegacyTokenXml || !Buffer.isBuffer(clepHmacSecret)) {
    throw new Error('exchangeUserTokenOnRst2 requires userLegacyTokenXml, deviceLegacyTokenXml, and clepHmacSecret');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('exchangeUserTokenOnRst2 requires a fetch implementation');
  }

  const cleanUserTokenXml = String(userLegacyTokenXml).trim();
  const cleanDeviceTokenXml = String(deviceLegacyTokenXml).trim();

  const authBlockXml =
    `<wsse:UsernameToken wsu:Id="user">` +
    `<wsse:UsernameHint>${escapeXmlText(username || 'user@example.com')}</wsse:UsernameHint>` +
    `<wsse:LoginOption>1</wsse:LoginOption>` +
    `</wsse:UsernameToken>` +
    cleanUserTokenXml +
    `<wsse:BinarySecurityToken id="DeviceDAToken" ValueType="urn:liveid:device">` +
    escapeXmlText(cleanDeviceTokenXml) +
    `</wsse:BinarySecurityToken>`;

  const soapXml = buildSignedRst2SoapEnvelope({
    authBlockXml,
    hostingApp,
    ssoFlags: 'SsoRestr',
    inlineUx,
    inlineFt,
    licenseSignatureKeyVersion: null,
    scopes,
    signingMode: 'hmac',
    clepHmacSecret,
    derivedKeyRefUri: '#DeviceDAToken',
  });

  const res = await fetchImpl(MSA_RST2_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/soap+xml',
      'User-Agent': MSA_WINDOWS_USER_AGENT,
    },
    body: soapXml,
    signal: createClepFetchSignal(signal),
  });

  const respXml = await res.text();
  const { decryptedPpXml, decryptedBodyXml, rawBodyXml } = decryptRst2SoapEnvelope(
    respXml,
    clepHmacSecret
  );
  const effectiveBody = decryptedBodyXml || rawBodyXml;
  const effectivePp = decryptedPpXml || respXml;

  if (/<(?:[\w-]+:)?Fault\b/i.test(effectiveBody)) {
    return {
      fault: true,
      status: res.status,
      reqStatus: extractXmlTagText(effectivePp, 'reqstatus'),
      inlineAuthUrl: extractXmlTagText(effectivePp, 'inlineauthurl'),
      inlineEndAuthUrl: extractXmlTagText(effectivePp, 'inlineendauthurl'),
      faultReason: extractXmlTagText(effectiveBody, 'Text') || `RST2 Fault (${res.status})`,
      tokens: [],
    };
  }

  const tokens = parseRst2TokenResponses(effectiveBody);
  return {
    fault: false,
    status: res.status,
    reqStatus: extractXmlTagText(effectivePp, 'reqstatus'),
    inlineAuthUrl: '',
    tokens,
  };
}

function normalizeLicensingMsaTicket(rawTicket) {
  const trimmed = String(rawTicket || '').trim();
  if (!trimmed) return '';
  const bare = trimmed.replace(/^[td]=/i, '');
  const parts = bare.split('.');
  if (parts.length === 5 && parts[0] && parts[2] && parts[3] && parts[4]) {
    try {
      const allBase64Url = parts.every(
        (part) => part.length % 4 !== 1 && /^[A-Za-z0-9_-]*$/.test(part)
      );
      if (allBase64Url && parts[0].length <= 8192) {
        const hdr = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (hdr && typeof hdr.alg === 'string' && hdr.alg && typeof hdr.enc === 'string' && hdr.enc) {
          return bare;
        }
      }
    } catch {}
  }
  if (/^d=/i.test(trimmed)) return `t=${bare}`;
  if (/^t=/i.test(trimmed)) return trimmed;
  return `t=${bare}`;
}

const DEFAULT_CLEP_HTTP_TIMEOUT_MS = 20_000;

function createClepFetchSignal(outerSignal, timeoutMs = DEFAULT_CLEP_HTTP_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (outerSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([outerSignal, timeoutSignal]);
  }
  return outerSignal || timeoutSignal;
}

function scrubPiiFromErrorText(rawMsg, maxLen = 140) {
  const cleaned = String(rawMsg || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]')
    .replace(/\b(?:[td]|XBL3\.0\s+x)=[^\s,;)"']+/gi, '[redacted-token]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){1,4}\b/g, '[redacted-jwt]')
    .replace(/\b(?:puid|xuid|membername|cid|ANID)\s*[:=]\s*[^\s,;)"']+/gi, '[redacted-id]')
    .replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]')
    .replace(/\b\d{12,}\b/g, '[redacted-num]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLen);
}

function extractSafeSoapFaultSuffix(rawXml) {
  const str = String(rawXml || '');
  if (!str) return '';
  const code =
    extractXmlTagText(str, 'reqstatus') ||
    extractXmlTagText(str, 'code') ||
    extractXmlTagText(str, 'Value');
  if (!code) return '';
  const safeCode = code.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
  return safeCode ? `, code=${safeCode}` : '';
}

function makeCorrelationVector() {
  return `${crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, 'A').slice(0, 16)}.0`;
}

// ============================================================================
// 4. Public Device Provisioning & Content CIK Acquisition API
// ============================================================================

let inFlightDeviceContextPromise = null;

/**
 * Provisions or refreshes a virtual Windows device (`deviceaddcredential.srf` -> `RST2.srf` ->
 * `<SPLicenseBlock>` `DeviceKey` + `ClepSignState` RSA-2048 key + `DeviceDAT` tokens) and persists
 * all state inside `tokenVault.cjs` (`xbox.deviceContext`) with zero macOS Keychain prompts.
 *
 * @param {{
 *   tokenVault?: any,
 *   userDataDir?: string,
 *   fetchImpl?: typeof fetch,
 *   forceRefresh?: boolean,
 *   requireLegacyToken?: boolean,
 *   msaStoreToken?: string,
 *   signal?: AbortSignal,
 * }} [options]
 */
async function ensureDeviceLicenseContext(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('ensureDeviceLicenseContext requires a fetch implementation');
  }

  const vault = options.tokenVault || require('../tokenVault.cjs');
  const userDataDir = options.userDataDir;

  const vaultOpts = userDataDir ? { userDataDir } : {};

  const readSavedXbox = () => {
    const all = vault.loadSavedTokens(vaultOpts) || {};
    return all.xbox && typeof all.xbox === 'object' ? all.xbox : {};
  };

  const persistDeviceCtx = (nextDeviceCtx) => {
    const existingXbox = readSavedXbox();
    vault.saveTokens(
      'xbox',
      {
        ...existingXbox,
        deviceContext: {
          ...(existingXbox.deviceContext || {}),
          ...nextDeviceCtx,
          updatedAt: new Date().toISOString(),
        },
      },
      vaultOpts
    );
  };

  const existing = readSavedXbox().deviceContext;
  const now = Date.now();
  const hasCachedLegacy =
    !options.requireLegacyToken ||
    (typeof existing?.deviceLegacyTokenXml === 'string' &&
      existing.deviceLegacyTokenXml.length > 0 &&
      typeof existing?.deviceBinarySecretB64 === 'string' &&
      existing.deviceBinarySecretB64.length > 0 &&
      (!existing.deviceLegacyExpiresAt || Date.parse(existing.deviceLegacyExpiresAt) - now > 5 * 60_000));

  if (
    !options.forceRefresh &&
    hasCachedLegacy &&
    existing &&
    typeof existing.deviceKeyHex === 'string' &&
    existing.deviceKeyHex.length === 32 &&
    typeof existing.clepRsaKeyPem === 'string' &&
    existing.clepRsaKeyPem.includes('PRIVATE KEY') &&
    existing.deviceDat &&
    (!existing.deviceDatExpiresAt || Date.parse(existing.deviceDatExpiresAt) - now > 5 * 60_000)
  ) {
    const clepHmacSecret = existing.deviceBinarySecretB64
      ? unwrapClepHmacStateSecret(existing.deviceBinarySecretB64)
      : null;
    const normalizedCachedDeviceToken = existing.deviceToken
      ? existing.deviceToken.startsWith('d=')
        ? `t=${existing.deviceToken.slice(2)}`
        : existing.deviceToken
      : existing.deviceDat;
    return {
      deviceMembername: existing.deviceMembername,
      devicePassword: existing.devicePassword,
      devicePuid: existing.devicePuid || '',
      hwDeviceId: existing.hwDeviceId || '',
      deviceToken: normalizedCachedDeviceToken,
      deviceDat: existing.deviceDat,
      deviceMsToken: existing.deviceMsToken || existing.deviceDat,
      deviceDatExpiresAt: existing.deviceDatExpiresAt,
      deviceLegacyTokenXml: existing.deviceLegacyTokenXml || '',
      deviceBinarySecretB64: existing.deviceBinarySecretB64 || '',
      clepHmacSecret,
      deviceKeyBuffer: Buffer.from(existing.deviceKeyHex, 'hex'),
      clepRsaKeyPem: existing.clepRsaKeyPem,
    };
  }

  if (inFlightDeviceContextPromise && !options.forceRefresh) {
    return inFlightDeviceContextPromise;
  }

  const run = (async () => {
    const hardwareSeed =
      typeof vault.getHardwareFingerprint === 'function'
        ? vault.getHardwareFingerprint()
        : undefined;
    const challenge = buildClepChallengeBuffers({ hardwareSeed });

    let deviceMembername = existing?.deviceMembername || '';
    let devicePassword = existing?.devicePassword || '';
    let devicePuid = existing?.devicePuid || '';
    let hwDeviceId = existing?.hwDeviceId || '';
    let deviceKeyBuffer =
      existing?.deviceKeyHex?.length === 32 ? Buffer.from(existing.deviceKeyHex, 'hex') : null;
    let clepRsaKeyPem = existing?.clepRsaKeyPem || '';

    // Step 1: Provision virtual Windows device credentials + SPLicenseBlock if not yet provisioned
    if (!deviceMembername || !devicePassword || !deviceKeyBuffer || !clepRsaKeyPem) {
      deviceMembername = generateNumericDeviceMembername();
      devicePassword = generateDevicePassword();

      const addXml = buildDeviceAddCredentialXml({
        membername: deviceMembername,
        password: devicePassword,
        clepV2B64: challenge.clepV2B64,
        clepV4B64: challenge.clepV4B64,
      });

      const addRes = await fetchImpl(MSA_DEVICE_ADD_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml',
          'User-Agent': MSA_WINDOWS_USER_AGENT,
        },
        body: addXml,
        signal: createClepFetchSignal(options.signal),
      });

      const addBody = await addRes.text();
      if (!addRes.ok) {
        throw new Error(
          `Device credential provisioning failed (${addRes.status}${extractSafeSoapFaultSuffix(addBody)})`
        );
      }

      devicePuid = extractXmlTagText(addBody, 'puid') || devicePuid;
      hwDeviceId = extractXmlTagText(addBody, 'HWDeviceID') || hwDeviceId;

      let spLicenseB64 = extractSpLicenseBase64(addBody);

      // Fallback to POST https://licensing.mp.microsoft.com/v7.0/licenses/device if SPLicenseBlock was omitted
      if (!spLicenseB64 && options.msaStoreToken) {
        const normTicket = normalizeLicensingMsaTicket(options.msaStoreToken);
        const devLicRes = await fetchImpl(MS_LICENSING_DEVICE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            from: 'XboxLicenseManager',
            Authorization: normTicket,
            'User-Agent': XBOX_LM_USER_AGENT,
            'MS-CV': makeCorrelationVector(),
          },
          body: JSON.stringify({
            clientChallenge: challenge.clientChallenge,
            licenseVersion: 4,
            deviceContext: {
              hardwareManufacturer: 'Public',
              hardwareType: 'Public',
              mobileOperator: 'Public',
            },
          }),
          signal: createClepFetchSignal(options.signal),
        });
        if (devLicRes.ok) {
          const devLicJson = await devLicRes.json();
          spLicenseB64 = extractSpLicenseBase64(
            devLicJson?.license?.licenseBlob ||
              devLicJson?.licenseBlob ||
              devLicJson?.licenses?.[0]?.licenseBlob ||
              ''
          );
        }
      }

      if (!spLicenseB64) {
        throw new Error('Device provisioning response did not include an SPLicenseBlock');
      }

      const parsedSp = parseSpLicenseBase64(spLicenseB64);
      if (!parsedSp.deviceKeyBuffer || parsedSp.deviceKeyBuffer.length !== 16) {
        throw new Error('SPLicenseBlock missing 16-byte EncryptedDeviceKey (0x0001)');
      }
      if (!parsedSp.clepRsaKeyPem) {
        throw new Error('SPLicenseBlock missing ClepSignState RSA-2048 key (0x012d)');
      }

      deviceKeyBuffer = parsedSp.deviceKeyBuffer;
      clepRsaKeyPem = parsedSp.clepRsaKeyPem;
    }

    // Step 2: Authenticate device on RST2.srf using RSA-2048 (`ClepSignState`) -> LegacyToken + ClepHmacState
    // IMPORTANT: `wsse:UsernameToken` MUST omit `<wsse:Password>` so RST2.srf issues a hardware-trusted STS token!
    const usernameTokenXml =
      `<wsse:UsernameToken wsu:Id="devicesoftware">` +
      `<wsse:Username>${escapeXmlText(deviceMembername)}</wsse:Username>` +
      `</wsse:UsernameToken>`;

    const rstAuthXml = buildSignedRst2SoapEnvelope({
      authBlockXml: usernameTokenXml,
      hostingApp: HOSTING_APP_DEFAULT_IDCRL,
      ssoFlags: '',
      inlineUx: 'TokenBroker',
      licenseSignatureKeyVersion: '2',
      scopeAddress: 'http://Passport.NET/tb',
      policy: '',
      signingMode: 'rsa',
      rsaPrivateKeyPem: clepRsaKeyPem,
    });

    const rstAuthRes = await fetchImpl(MSA_RST2_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml',
        'User-Agent': MSA_WINDOWS_USER_AGENT,
      },
      body: rstAuthXml,
      signal: createClepFetchSignal(options.signal),
    });

    const rstAuthBody = await rstAuthRes.text();
    if (!rstAuthRes.ok) {
      throw new Error(
        `RST2.srf device authentication failed (${rstAuthRes.status}${extractSafeSoapFaultSuffix(rstAuthBody)})`
      );
    }

    const parsedAuthTokens = parseRst2TokenResponses(rstAuthBody);
    const firstLegacy = parsedAuthTokens[0] || null;
    const legacyTokenXml =
      firstLegacy?.legacyTokenXml ||
      (rstAuthBody.match(/<(?:[\w-]+:)?EncryptedData\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?EncryptedData>/i)?.[0] || '');
    const binarySecretB64 = firstLegacy?.binarySecretB64 || extractXmlTagText(rstAuthBody, 'BinarySecret');
    if (!legacyTokenXml || !binarySecretB64) {
      throw new Error('RST2.srf device auth response missing EncryptedData or BinarySecret');
    }

    const deviceLegacyExpiresAt =
      firstLegacy?.expires && !Number.isNaN(Date.parse(firstLegacy.expires))
        ? new Date(Date.parse(firstLegacy.expires)).toISOString()
        : new Date(Date.now() + 14 * 24 * 3600_000).toISOString();

    const clepHmacSecret = unwrapClepHmacStateSecret(binarySecretB64);

    // Step 3A: Exchange LegacyToken + SP800-108 HMAC for Microsoft Store Device ticket (`www.microsoft.com` / `mbi_ssl`)
    const exchangeForScope = async (hostingApp, scopeAddress, policy) => {
      const exXml = buildSignedRst2SoapEnvelope({
        authBlockXml: legacyTokenXml,
        hostingApp,
        ssoFlags: 'SsoRestr',
        inlineUx: 'TokenBroker',
        licenseSignatureKeyVersion: '2',
        scopeAddress,
        policy,
        signingMode: 'hmac',
        clepHmacSecret,
        derivedKeyRefUri: '',
      });

      const exRes = await fetchImpl(MSA_RST2_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml',
          'User-Agent': MSA_WINDOWS_USER_AGENT,
        },
        body: exXml,
        signal: createClepFetchSignal(options.signal),
      });

      const exBody = await exRes.text();
      if (!exRes.ok) {
        throw new Error(
          `RST2.srf device token exchange failed (${exRes.status}${extractSafeSoapFaultSuffix(exBody)})`
        );
      }

      const { decryptedBodyXml, rawBodyXml } = decryptRst2SoapEnvelope(exBody, clepHmacSecret);
      const effectiveRstr = decryptedBodyXml || rawBodyXml;
      const parsed = parseRst2TokenResponses(effectiveRstr);
      const item = parsed[0];
      const compactToken = item?.compactToken || extractCompactBinarySecurityToken(effectiveRstr);
      const expiresStr = item?.expires || extractXmlTagText(effectiveRstr, 'Expires');
      if (!compactToken) {
        throw new Error(`RST2.srf exchange for ${scopeAddress} returned empty BinarySecurityToken`);
      }
      return { compactToken, expiresStr };
    };

    const msStoreEx = await exchangeForScope(HOSTING_APP_MS_STORE, 'www.microsoft.com', 'mbi_ssl');
    // `licensing.mp.microsoft.com` expects the compact device ticket (`t=...`) directly in `Authorization`!
    const deviceMsToken = msStoreEx.compactToken.startsWith('d=')
      ? `t=${msStoreEx.compactToken.slice(2)}`
      : msStoreEx.compactToken;

    // Step 3B: Best-effort Xbox Device RPS ticket (`user.auth.xboxlive.com` / `TOKEN_BROKER`) for `device.auth.xboxlive.com`
    let deviceXboxRpsTicket = '';
    try {
      const xblDevEx = await exchangeForScope(
        HOSTING_APP_TOKEN_BROKER,
        'scope=service::user.auth.xboxlive.com::MBI_SSL&api-version=2.0',
        'TOKEN_BROKER'
      );
      if (xblDevEx.compactToken) {
        const c = xblDevEx.compactToken.trim();
        deviceXboxRpsTicket = c.startsWith('t=')
          ? c
          : c.startsWith('d=')
            ? `t=${c.slice(2)}`
            : `t=${c}`;
      }
    } catch {
      // Non-fatal: `licensing.mp.microsoft.com` only requires `deviceMsToken`
    }

    const deviceDatExpiresAt =
      msStoreEx.expiresStr && !Number.isNaN(Date.parse(msStoreEx.expiresStr))
        ? new Date(Date.parse(msStoreEx.expiresStr)).toISOString()
        : new Date(Date.now() + 7 * 3600_000).toISOString();

    const persisted = {
      deviceMembername,
      devicePassword,
      devicePuid,
      hwDeviceId,
      deviceToken: deviceXboxRpsTicket || deviceMsToken,
      deviceDat: deviceMsToken,
      deviceMsToken,
      deviceDatExpiresAt,
      deviceLegacyTokenXml: legacyTokenXml,
      deviceBinarySecretB64: binarySecretB64,
      deviceLegacyExpiresAt,
      deviceKeyHex: deviceKeyBuffer.toString('hex'),
      clepRsaKeyPem,
    };
    persistDeviceCtx(persisted);

    return {
      deviceMembername,
      devicePassword,
      devicePuid,
      hwDeviceId,
      deviceToken: persisted.deviceToken,
      deviceDat: deviceMsToken,
      deviceMsToken,
      deviceDatExpiresAt,
      deviceLegacyTokenXml: legacyTokenXml,
      deviceBinarySecretB64: binarySecretB64,
      clepHmacSecret,
      deviceKeyBuffer,
      clepRsaKeyPem,
    };
  })().finally(() => {
    inFlightDeviceContextPromise = null;
  });

  inFlightDeviceContextPromise = run;
  return run;
}

/**
 * Acquires a hardware-bound `TOKEN_BROKER` delegation RPS ticket (`d=...`) for a specific game's
 * `<MSAAppId>` (supports both 16-hex LiveSDK AppIds like `0000000012345678` and modern Azure AD UUIDs)
 * via `https://login.live.com/RST2.srf` signed with the virtual Windows device `LegacyToken` + `ClepHmacState`.
 * Used with `POST https://title.auth.xboxlive.com/title/authenticate` to mint a title-bound `TitleToken`.
 */
async function acquireTitleBrokerTicket(options = {}) {
  const cleanAppId = String(options.msaAppId || '').trim();
  if (!cleanAppId) return null;

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for acquireTitleBrokerTicket');
  }

  const devCtx = await ensureDeviceLicenseContext({
    tokenVault: options.tokenVault,
    userDataDir: options.userDataDir,
    fetchImpl,
    forceRefresh: Boolean(options.forceRefresh),
    requireLegacyToken: true,
  });

  if (!devCtx?.deviceLegacyTokenXml || !devCtx?.clepHmacSecret) {
    throw new Error('Device LegacyToken or ClepHmacState unavailable for TOKEN_BROKER exchange');
  }

  const scopeAddress = `scope=service::user.auth.xboxlive.com::MBI_SSL&clientid=${cleanAppId}&api-version=2.0`;
  const exXml = buildSignedRst2SoapEnvelope({
    authBlockXml: devCtx.deviceLegacyTokenXml,
    hostingApp: HOSTING_APP_TOKEN_BROKER,
    ssoFlags: 'SsoRestr',
    inlineUx: 'TokenBroker',
    licenseSignatureKeyVersion: '2',
    scopeAddress,
    policy: 'TOKEN_BROKER',
    signingMode: 'hmac',
    clepHmacSecret: devCtx.clepHmacSecret,
    derivedKeyRefUri: '',
  });

  const exRes = await fetchImpl(MSA_RST2_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/soap+xml',
      'User-Agent': MSA_WINDOWS_USER_AGENT,
    },
    body: exXml,
    signal: createClepFetchSignal(options.signal),
  });

  const exBody = await exRes.text();
  if (!exRes.ok) {
    throw new Error(
      `RST2.srf title TOKEN_BROKER exchange failed for ${cleanAppId} (${exRes.status}${extractSafeSoapFaultSuffix(exBody)})`
    );
  }

  const { decryptedBodyXml, rawBodyXml } = decryptRst2SoapEnvelope(exBody, devCtx.clepHmacSecret);
  const effectiveRstr = decryptedBodyXml || rawBodyXml;
  const parsed = parseRst2TokenResponses(effectiveRstr);
  const item = parsed[0];
  const compactToken = (
    item?.compactToken ||
    extractCompactBinarySecurityToken(effectiveRstr) ||
    ''
  ).trim();
  if (!compactToken) {
    throw new Error(`RST2.srf title TOKEN_BROKER exchange for ${cleanAppId} returned empty ticket`);
  }

  const rpsTicket =
    compactToken.startsWith('d=') || compactToken.startsWith('t=')
      ? compactToken
      : `d=${compactToken}`;
  const rawExpires = item?.expires || extractXmlTagText(effectiveRstr, 'Expires');
  const expiresAt =
    rawExpires && !Number.isNaN(Date.parse(rawExpires))
      ? new Date(Date.parse(rawExpires)).toISOString()
      : new Date(Date.now() + 4 * 3600_000).toISOString();

  return {
    rpsTicket,
    expiresAt,
    msaAppId: cleanAppId,
  };
}

function normalizeSatisfyingEntitlementKeys(keys) {
  if (!Array.isArray(keys)) return [];
  const normalized = [];
  for (const item of keys) {
    if (!item) continue;
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed) continue;
      if (trimmed.includes(':')) {
        const parts = trimmed.split(':');
        // Handle both "big:9N...:0010" and "9N...:0010"
        if (parts.length === 3 && parts[0].toLowerCase() === 'big') {
          normalized.push({
            productId: parts[1].trim(),
            skuId: (parts[2] || '0010').trim() || '0010',
          });
        } else {
          normalized.push({
            productId: parts[0].trim(),
            skuId: (parts[1] || '0010').trim() || '0010',
          });
        }
      } else {
        normalized.push({ productId: trimmed, skuId: '0010' });
      }
    } else if (typeof item === 'object' && item.productId) {
      normalized.push({
        productId: String(item.productId).trim(),
        skuId: String(item.skuId || '0010').trim() || '0010',
      });
    }
  }
  return normalized;
}

const MKMS_CONTENT_CLIENT_CHALLENGE =
  'PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiID8+PENsaWVudENoYWxsZW5nZSB4bWxuczp4c2k9Imh0dHA6Ly93d3cudzMub3JnLzIwMDEvWE1MU2NoZW1hLWluc3RhbmNlIiB4bWxuczp4c2Q9Imh0dHA6Ly93d3cudzMub3JnLzIwMDEvWE1MU2NoZW1hIiB4bWxucz0iaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS9vbmVzdG9yZS9zZWN1cml0eS9ta21zL0xpY1JlcS92MSIgVmVyc2lvbj0iMiI+PExpY2Vuc2VQcm90b2NvbFZlcnNpb24+NTwvTGljZW5zZVByb3RvY29sVmVyc2lvbj48U2lnbmluZ0tleVZlcnNpb24+MTwvU2lnbmluZ0tleVZlcnNpb24+PENsaWVudFZlcnNpb24+MjwvQ2xpZW50VmVyc2lvbj48L0NsaWVudENoYWxsZW5nZT4=';

function formatDeviceAuthHeaderForLicensing(deviceContext, fallbackUserTicket) {
  const raw = String(
    deviceContext?.deviceMsToken || deviceContext?.deviceDat || deviceContext?.deviceToken || ''
  ).trim();
  if (!raw) return fallbackUserTicket;
  if (raw.startsWith('d=')) return `t=${raw.slice(2)}`;
  return raw;
}

/**
 * Acquires a game/DLC content license from `POST https://licensing.mp.microsoft.com/v7.0/licenses/content`,
 * automatically retrying with `satisfyingEntitlementKeys` for bundle/Game Pass titles, parses Tag `0x00ca`,
 * and unwraps the 32-byte raw XVD `CIK` via RFC 3394 AES-128 Key Unwrap.
 *
 * @param {{
 *   contentId: string,
 *   packageFullNames?: string[],
 *   satisfyingEntitlementKeys?: Array<string | { productId: string, skuId?: string }>,
 *   msaStoreToken: string,
 *   localTicketReference?: string,
 *   deviceContext: { deviceMsToken?: string, deviceDat?: string, deviceToken?: string, deviceKeyBuffer: Buffer },
 *   market?: string,
 *   hardwareSeed?: string,
 *   clientChallengeOverride?: string,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 * }} [params]
 */
async function acquireContentCik(params = /** @type {any} */ ({})) {
  const {
    contentId,
    packageFullNames = [],
    satisfyingEntitlementKeys = [],
    msaStoreToken,
    localTicketReference,
    deviceContext,
    market = 'US',
    hardwareSeed,
  } = params;
  const fetchImpl = params.fetchImpl || globalThis.fetch;

  if (!contentId || typeof contentId !== 'string') {
    throw new Error('acquireContentCik requires a non-empty contentId');
  }
  if (!msaStoreToken || typeof msaStoreToken !== 'string') {
    throw new Error('acquireContentCik requires msaStoreToken');
  }
  if (!deviceContext || !Buffer.isBuffer(deviceContext.deviceKeyBuffer) || deviceContext.deviceKeyBuffer.length !== 16) {
    throw new Error('acquireContentCik requires deviceContext.deviceKeyBuffer (16 bytes)');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('acquireContentCik requires a fetch implementation');
  }

  const licensingUserTicket = normalizeLicensingMsaTicket(msaStoreToken);
  const ticketRef = String(localTicketReference || '').trim() || `ticket-${crypto.randomUUID()}`;
  const clientChallenge = params.clientChallengeOverride || MKMS_CONTENT_CLIENT_CHALLENGE;
  const authHeader = formatDeviceAuthHeaderForLicensing(deviceContext, licensingUserTicket);

  const normalizedEntitlementKeys = normalizeSatisfyingEntitlementKeys(satisfyingEntitlementKeys);
  const cleanPfns = Array.isArray(packageFullNames)
    ? packageFullNames.map((p) => String(p || '').trim()).filter(Boolean)
    : [];

  const attemptRequest = async (entitlementKeysToSend, includePfns = false) => {
    const body = {
      contentId: contentId.trim(),
      market: String(market || 'US').toUpperCase(),
      clientChallenge,
      concurrencyMode: 'Rude',
      licenseVersion: 4,
      needKey: true,
      keyOnly: true,
      ...(includePfns && cleanPfns.length > 0 ? { packageFullNames: cleanPfns } : {}),
      ...(entitlementKeysToSend && entitlementKeysToSend.length > 0
        ? { satisfyingEntitlementKeys: entitlementKeysToSend }
        : {}),
      deviceContext: {
        hardwareManufacturer: 'Public',
        hardwareType: 'Public',
        mobileOperator: 'Public',
      },
      users: {
        [LOCAL_USER_SID]: [
          {
            identityType: 'Msa',
            identityValue: licensingUserTicket,
            localTicketReference: ticketRef,
          },
        ],
      },
    };

    const res = await fetchImpl(MS_LICENSING_CONTENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        from: 'XboxLicenseManager',
        Authorization: authHeader,
        'User-Agent': XBOX_LM_USER_AGENT,
        'MS-CV': makeCorrelationVector(),
      },
      body: JSON.stringify(body),
      signal: createClepFetchSignal(params.signal),
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { ok: res.ok, status: res.status, text, json };
  };

  // Attempt 1: bare ContentId (fastest & matches direct digital ownership)
  let response = await attemptRequest(null);

  const extractBlobsFromResponse = (json) => {
    if (!json || typeof json !== 'object') return [];
    const blobs = [];
    if (Array.isArray(json?.license?.keys)) {
      for (const k of json.license.keys) {
        if (k?.value) blobs.push(k.value);
      }
    }
    if (typeof json?.license?.licenseBlob === 'string' && json.license.licenseBlob) {
      blobs.push(json.license.licenseBlob);
    }
    if (Array.isArray(json?.licenses)) {
      for (const lic of json.licenses) {
        if (Array.isArray(lic?.keys)) {
          for (const k of lic.keys) {
            if (k?.value) blobs.push(k.value);
          }
        }
        if (typeof lic?.licenseBlob === 'string' && lic.licenseBlob) {
          blobs.push(lic.licenseBlob);
        }
      }
    }
    return blobs;
  };

  const tryUnwrapCandidateBlobs = (blobs) => {
    const unwrappedKeys = [];
    let resolvedLicenseId = null;
    let resolvedPackageFullName = null;
    let lastParseErr = null;

    for (const blob of blobs) {
      let parsed;
      try {
        parsed = parseSpLicenseBase64(blob, {
          verifyCmacWithKey: deviceContext.deviceKeyBuffer,
        });
      } catch (err) {
        const errCode = /** @type {any} */ (err)?.code;
        if (errCode === 'SPLICENSE_CMAC_TAMPERED' || errCode === 'SPLICENSE_SIGNATURE_TAMPERED') {
          throw err;
        }
        const errMsg = err instanceof Error ? err.message : String(err || '');
        if (errMsg !== 'Empty SPLicense payload') {
          lastParseErr = err;
        }
        continue;
      }

      if (!resolvedLicenseId && parsed.licenseId) resolvedLicenseId = parsed.licenseId;
      if (!resolvedPackageFullName && parsed.packageFullName) {
        resolvedPackageFullName = parsed.packageFullName;
      }
      for (const entry of parsed.packedContentKeys) {
        const cikBuffer = unwrapContentCik(entry.wrappedCik, deviceContext.deviceKeyBuffer);
        unwrappedKeys.push({
          keyId: entry.keyId,
          keyIdRaw: entry.keyIdRaw,
          wrappedCik: entry.wrappedCik,
          cikBuffer,
          cikHex: cikBuffer.toString('hex'),
        });
      }
    }

    return {
      unwrappedKeys,
      resolvedLicenseId,
      resolvedPackageFullName,
      lastParseErr,
    };
  };

  let candidateBlobs = response.ok ? extractBlobsFromResponse(response.json) : [];
  let unwrapResult =
    response.ok && candidateBlobs.length > 0
      ? tryUnwrapCandidateBlobs(candidateBlobs)
      : { unwrappedKeys: [], resolvedLicenseId: null, resolvedPackageFullName: null, lastParseErr: null };

  // Attempt 2: Retry with `satisfyingEntitlementKeys` (Game Pass subscription / Bundle SKU satisfaction)
  // Also triggers when Attempt 1 returned HTTP 200 with a key-less `<License>` wrapper (0 `PackedContentKeys`)!
  if (
    (!response.ok || candidateBlobs.length === 0 || unwrapResult.unwrappedKeys.length === 0) &&
    normalizedEntitlementKeys.length > 0
  ) {
    response = await attemptRequest(normalizedEntitlementKeys);
    candidateBlobs = response.ok ? extractBlobsFromResponse(response.json) : [];
    unwrapResult =
      response.ok && candidateBlobs.length > 0
        ? tryUnwrapCandidateBlobs(candidateBlobs)
        : { unwrappedKeys: [], resolvedLicenseId: null, resolvedPackageFullName: null, lastParseErr: null };

    // Attempt 2B: Some Microsoft Store clusters accept string `"ProductId:SkuId"` entries
    if (!response.ok && response.status === 400) {
      const stringKeys = normalizedEntitlementKeys.map((k) => `${k.productId}:${k.skuId}`);
      const fallbackRes = await attemptRequest(stringKeys);
      if (fallbackRes.ok) {
        response = fallbackRes;
        candidateBlobs = extractBlobsFromResponse(fallbackRes.json);
        unwrapResult =
          candidateBlobs.length > 0
            ? tryUnwrapCandidateBlobs(candidateBlobs)
            : { unwrappedKeys: [], resolvedLicenseId: null, resolvedPackageFullName: null, lastParseErr: null };
      }
    }
  }

  if (!response.ok || candidateBlobs.length === 0) {
    if (response.json?.satisfactionFailure) {
      const sf = response.json.satisfactionFailure;
      const safeDesc =
        scrubPiiFromErrorText(sf.description) ||
        'Account lacks an active entitlement or Game Pass tier for this game.';
      const err = Object.assign(
        new Error(
          `Not entitled to this content (${sf.code ?? 'SATISFACTION_FAILURE'}): ${safeDesc}`
        ),
        { status: response.status, code: 'NOT_ENTITLED' }
      );
      throw err;
    }
    const errCode = String(
      response.json?.innererror?.code || response.json?.code || `HTTP_${response.status}`
    )
      .replace(/[^A-Za-z0-9_.:-]/g, '')
      .slice(0, 64);
    const structuredMsg = scrubPiiFromErrorText(
      response.json?.innererror?.message || response.json?.message || ''
    );
    const errMsg = structuredMsg || 'Failed to acquire SPLicense content key';
    const err = Object.assign(
      new Error(`Content license acquisition failed (${errCode}): ${errMsg}`),
      { status: response.status, code: errCode }
    );
    throw err;
  }

  const { unwrappedKeys, resolvedLicenseId, resolvedPackageFullName, lastParseErr } = unwrapResult;

  if (unwrappedKeys.length === 0) {
    if (lastParseErr) {
      throw lastParseErr;
    }
    throw new Error(`SPLicense for contentId=${contentId} did not contain any PackedContentKeys (0x00ca)`);
  }

  const primary = unwrappedKeys[0];
  return {
    contentId: contentId.trim(),
    keyId: primary.keyId,
    cikBuffer: primary.cikBuffer,
    cikHex: primary.cikHex,
    keys: unwrappedKeys,
    licenseId: resolvedLicenseId,
    packageFullName: resolvedPackageFullName,
    rawResponse: response.json,
  };
}

/**
 * Acquires a `v8.0/licenseToken` JWT used by bottled GDK games calling `XStoreQueryLicenseTokenAsync`.
 */
async function acquireStoreLicenseToken(params = {}) {
  const {
    parentProductId,
    productIds = [],
    customDeveloperString = '',
    msaStoreToken,
    localTicketReference,
    deviceContext,
  } = params;
  const fetchImpl = params.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('acquireStoreLicenseToken requires a fetch implementation');
  }

  const licensingUserTicket = normalizeLicensingMsaTicket(msaStoreToken);
  const ticketRef = String(localTicketReference || '').trim() || `ticket-${crypto.randomUUID()}`;
  const authHeader = formatDeviceAuthHeaderForLicensing(deviceContext, licensingUserTicket);
  const resolvedParent = String(parentProductId || productIds[0] || '').split('/')[0].trim();
  const relatedIds = productIds.length > 0 ? productIds : resolvedParent ? [resolvedParent] : [];

  const res = await fetchImpl(MS_LICENSING_STORE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      from: 'XboxLicenseManager',
      Authorization: authHeader,
      'User-Agent': XBOX_LM_USER_AGENT,
      'MS-CV': makeCorrelationVector(),
    },
    body: JSON.stringify({
      parentProductId: resolvedParent,
      enforceSellableBy: true,
      relatedProductIds: relatedIds,
      customDeveloperString: String(customDeveloperString || ''),
      beneficiaries: [
        {
          identityType: 'Msa',
          identityValue: licensingUserTicket,
          localTicketReference: ticketRef,
        },
      ],
    }),
    signal: createClepFetchSignal(params.signal),
  });

  if (!res.ok) {
    const body = await res.text();
    let safeSuffix = '';
    try {
      const parsedErr = body ? JSON.parse(body) : null;
      const code = parsedErr?.innererror?.code || parsedErr?.code || '';
      const cleanCode = String(code).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
      if (cleanCode) safeSuffix = ` (${cleanCode})`;
    } catch {}
    throw new Error(`Store licenseToken failed (HTTP ${res.status})${safeSuffix}`);
  }
  return res.json();
}

module.exports = {
  BLOCK_ID,
  MKMS_CONTENT_CLIENT_CHALLENGE,
  HOSTING_APP_DEFAULT_IDCRL,
  HOSTING_APP_MS_STORE,
  HOSTING_APP_TOKEN_BROKER,
  HOSTING_APP_XBOX_PC,
  CLEP_INITIAL_STATE,
  clepObfuscate,
  clepDeobfuscate,
  buildSyntheticHardwareTables,
  buildClepChallengeBuffers,
  getLicenseChallenge,
  deriveClepKeyFromSchedule,
  buildKeyScheduleForTargetKey,
  decryptCbcZeroIv,
  encryptCbcZeroIv,
  aes128Cmac,
  parseBcryptRsaPrivateKeyToPem,
  exportPemToBcryptRsa2Blob,
  formatMixedEndianGuid,
  encodeMixedEndianGuid,
  aesKeyWrapRfc3394,
  aesKeyUnwrapRfc3394,
  unwrapContentCik,
  wrapContentCik,
  extractAllSpLicenseBase64Blocks,
  extractSpLicenseBase64,
  verifyLicenseXmlDsigIfPresent,
  parseSpLicenseBuffer,
  parseSpLicenseBase64,
  generateSp800108SharedKey,
  deriveDoubleDerivedHmacKey,
  unwrapClepHmacStateSecret,
  buildSignedRst2SoapEnvelope,
  decryptRst2SoapEnvelope,
  decryptRst2EncryptedDataXml,
  parseRst2TokenResponses,
  exchangeUserTokenOnRst2,
  normalizeLicensingMsaTicket,
  ensureDeviceLicenseContext,
  acquireTitleBrokerTicket,
  acquireContentCik,
  acquireStoreLicenseToken,
};
