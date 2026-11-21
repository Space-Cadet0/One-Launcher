// @ts-check
'use strict';

/**
 * CLEP Cryptographic Primitives (`clepCryptoPrimitives.cjs`):
 * - ClepV2/ClepV4 2048-byte Feistel CBC obfuscator (`clepObfuscate`, `clepDeobfuscate`)
 * - `ClepSignState` / `EncryptedDeviceKey` 58-word key schedule derivation
 * - AES-128-CBC (zero IV) & single-cipher RFC 4493 `AES-128-CMAC`
 * - Hardened `BCRYPT_RSAKEY_BLOB` (`RSA2`/`RSA3`) -> PKCS#8 PEM converter with full prime/coprime guards
 * - SHA-256 keyed bounded RSA private key PEM object cache (zero plaintext PEM strings as Map keys)
 * - Mixed-endian GUID codec, RFC 3394 CIK wrap/unwrap, NIST SP 800-108 Counter KDF & `ClepHmacState` unwrapper
 */

const crypto = require('node:crypto');
const {
  RFC3394_DEFAULT_IV,
  aesKeyWrapRfc3394,
  aesKeyUnwrapRfc3394,
} = require('../xboxBoringSslCrypto.cjs');

const MAX_PARSED_RSA_PRIVATE_KEYS = 32;
/** @type {Map<string, crypto.KeyObject>} */
const parsedRsaPrivateKeyCache = new Map();

/**
 * Computes a SHA-256 hex digest of a PEM string/Buffer so plaintext private key material is never
 * stored as a JS Map key.
 *
 * @param {string | Buffer} pemOrBuf
 * @returns {string}
 */
function hashPrivateKeyPem(pemOrBuf) {
  const hash = crypto.createHash('sha256');
  if (Buffer.isBuffer(pemOrBuf)) {
    hash.update(pemOrBuf);
  } else {
    hash.update(String(pemOrBuf), 'utf8');
  }
  return hash.digest('hex');
}

/**
 * @param {string | Buffer | crypto.KeyObject} pemOrKey
 * @returns {crypto.KeyObject}
 */
function getCachedRsaPrivateKeyObject(pemOrKey) {
  if (!pemOrKey) {
    throw new Error('Missing RSA private key');
  }
  if (typeof pemOrKey === 'object' && !Buffer.isBuffer(pemOrKey)) {
    return pemOrKey;
  }
  const cacheKey = hashPrivateKeyPem(pemOrKey);
  const hit = parsedRsaPrivateKeyCache.get(cacheKey);
  if (hit) {
    parsedRsaPrivateKeyCache.delete(cacheKey);
    parsedRsaPrivateKeyCache.set(cacheKey, hit);
    return hit;
  }
  const parsed = crypto.createPrivateKey(pemOrKey);
  if (parsedRsaPrivateKeyCache.size >= MAX_PARSED_RSA_PRIVATE_KEYS) {
    const oldest = parsedRsaPrivateKeyCache.keys().next().value;
    if (oldest !== undefined) parsedRsaPrivateKeyCache.delete(oldest);
  }
  parsedRsaPrivateKeyCache.set(cacheKey, parsed);
  return parsed;
}

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

/**
 * @param {number} x
 * @param {number} n
 */
function rotr32(x, n) {
  const v = x >>> 0;
  const s = n & 31;
  return s === 0 ? v : ((v >>> s) | (v << (32 - s))) >>> 0;
}

/**
 * @param {number} x
 * @param {number} n
 */
function rotl32(x, n) {
  const v = x >>> 0;
  const s = n & 31;
  return s === 0 ? v : ((v << s) | (v >>> (32 - s))) >>> 0;
}

/**
 * @param {number} a
 * @param {number} b
 */
function add32(a, b) {
  return ((a >>> 0) + (b >>> 0)) >>> 0;
}

/**
 * @param {number} a
 * @param {number} b
 */
function sub32(a, b) {
  return ((a >>> 0) - (b >>> 0)) >>> 0;
}

/**
 * @param {number} a
 * @param {number} b
 */
function mul32(a, b) {
  return Math.imul(a >>> 0, b >>> 0) >>> 0;
}

/** @param {number} x */
function clepRound1(x) {
  return sub32(mul32(CLEP_MAGIC_04, rotr32((x ^ CLEP_MAGIC_HI) >>> 0, 22)), rotr32(x, 8));
}

/** @param {number} x */
function clepRound2(x) {
  return mul32(CLEP_MAGIC_04, (rotr32(x, 15) ^ CLEP_MAGIC_01) >>> 0);
}

/** @param {number} x */
function clepRound3(x) {
  return add32((x >>> 0) >>> 9, mul32(CLEP_MAGIC_02, rotl32((x ^ CLEP_MAGIC_03) >>> 0, 3)));
}

/** @param {number} x */
function clepRound4(x) {
  return (rotr32(x, 28) ^ mul32(CLEP_MAGIC_03, rotr32((x ^ CLEP_MAGIC_HI) >>> 0, 9))) >>> 0;
}

/** @param {number} x */
function clepRound5(x) {
  return add32(rotr32(x, 12), mul32(CLEP_MAGIC_04, rotr32(sub32(x, CLEP_MAGIC_HI), 14)));
}

/** @param {number} x */
function clepRound6(x) {
  return (rotr32(x, 11) ^ mul32(CLEP_MAGIC_01, rotl32((x ^ CLEP_MAGIC_02) >>> 0, 2))) >>> 0;
}

/** @param {number} x */
function clepRound7(x) {
  return sub32(sub32(x, CLEP_MAGIC_LO), CLEP_MAGIC_02);
}

/** @param {number} x */
function clepRound8(x) {
  return sub32(mul32(CLEP_MAGIC_03, rotl32((x ^ CLEP_MAGIC_01) >>> 0, 2)), rotr32(x, 18));
}

/** @param {number} x */
function clepRound0(x) {
  return sub32(mul32(CLEP_MAGIC_04, rotr32(sub32(x, CLEP_MAGIC_HI), 18)), rotr32(x, 9));
}

/** @param {number} x */
function clepWhiten(x) {
  return sub32(mul32(CLEP_MAGIC_03, rotr32(add32(x, CLEP_MAGIC_HI), 10)), rotr32(x, 29));
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {[number, number]}
 */
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

/**
 * @param {number} a
 * @param {number} b
 * @returns {[number, number]}
 */
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

// ============================================================================
// 2. `ClepSignState` / `EncryptedDeviceKey` Schedule, AES-CBC, AES-CMAC, RSA-2048
// ============================================================================

/**
 * Derives the 16-byte AES-128 key from a 58-word (`u32[58]`, 232-byte LE) `Clep` key schedule.
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

/**
 * @param {Buffer} key16
 * @param {Buffer} ciphertext
 * @returns {Buffer}
 */
function decryptCbcZeroIv(key16, ciphertext) {
  if (!Buffer.isBuffer(key16) || key16.length !== 16) {
    throw new Error('decryptCbcZeroIv requires a 16-byte AES-128 key');
  }
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error(
      `decryptCbcZeroIv requires non-empty 16-byte aligned buffer (got ${ciphertext?.length})`
    );
  }
  const decipher = crypto.createDecipheriv('aes-128-cbc', key16, Buffer.alloc(16, 0));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * @param {Buffer} key16
 * @param {Buffer} plaintext
 * @returns {Buffer}
 */
function encryptCbcZeroIv(key16, plaintext) {
  if (!Buffer.isBuffer(key16) || key16.length !== 16) {
    throw new Error('encryptCbcZeroIv requires a 16-byte AES-128 key');
  }
  if (!Buffer.isBuffer(plaintext) || plaintext.length === 0 || plaintext.length % 16 !== 0) {
    throw new Error(
      `encryptCbcZeroIv requires non-empty 16-byte aligned buffer (got ${plaintext?.length})`
    );
  }
  const cipher = crypto.createCipheriv('aes-128-cbc', key16, Buffer.alloc(16, 0));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * @param {Buffer} block16
 * @returns {Buffer}
 */
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

/**
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {Buffer}
 */
function xorBlock16(a, b) {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}

/**
 * Pure Node.js RFC 4493 / NIST SP 800-38B `AES-128-CMAC` implementation using a single
 * stateless `aes-128-ecb` cipher context across the entire message.
 *
 * @param {Buffer} key16 16-byte AES-128 key
 * @param {Buffer | string} message arbitrary-length message buffer
 * @returns {Buffer} 16-byte CMAC tag
 */
function aes128Cmac(key16, message) {
  if (!Buffer.isBuffer(key16) || key16.length !== 16) {
    throw new Error('aes128Cmac requires a 16-byte key');
  }
  const msg = Buffer.isBuffer(message) ? message : Buffer.from(message || '');
  const Rb = 0x87;

  const cipher = crypto.createCipheriv('aes-128-ecb', key16, null);
  cipher.setAutoPadding(false);

  const L = cipher.update(Buffer.alloc(16, 0));
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
    x = cipher.update(y);
  }
  const tag = cipher.update(xorBlock16(x, mLast));
  cipher.final();
  return tag;
}

/**
 * @param {Buffer} buf
 * @returns {bigint}
 */
function bigIntFromBeBuffer(buf) {
  if (!buf || buf.length === 0) return 0n;
  return BigInt('0x' + buf.toString('hex'));
}

/**
 * @param {bigint} value
 * @param {number} [minByteLen]
 * @returns {string}
 */
function bigIntToBase64Url(value, minByteLen = 0) {
  if (value < 0n) {
    throw new RangeError('bigIntToBase64Url requires a non-negative BigInt');
  }
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

/**
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
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
 * Computes the modular multiplicative inverse `a^-1 mod m` with explicit modulus and coprime guards
 * so malformed RSA parameters never divide by zero or return invalid inverses.
 *
 * @param {bigint} a
 * @param {bigint} m
 * @returns {bigint}
 */
function modInverseBigInt(a, m) {
  if (typeof a !== 'bigint' || typeof m !== 'bigint' || m <= 1n) {
    throw new Error('Invalid modulus for RSA modular inverse (modulus must be > 1)');
  }
  const normalizedA = ((a % m) + m) % m;
  if (normalizedA === 0n || gcdBigInt(normalizedA, m) !== 1n) {
    throw new Error('RSA modular inverse does not exist (operands are not coprime)');
  }

  let m0 = m;
  let x0 = 0n;
  let x1 = 1n;
  let cur = normalizedA;
  while (cur > 1n) {
    if (m0 === 0n) {
      throw new Error('RSA modular inverse does not exist (division by zero prevented)');
    }
    const q = cur / m0;
    let t = m0;
    m0 = cur % m0;
    cur = t;
    t = x0;
    x0 = x1 - q * x0;
    x1 = t;
  }
  if (x1 < 0n) x1 += m;
  if ((normalizedA * x1) % m !== 1n) {
    throw new Error('RSA modular inverse verification failed');
  }
  return x1;
}

/**
 * Parses a Windows `BCRYPT_RSAKEY_BLOB` (`RSA2` = `0x32415352` or `RSA3` = `0x33415352`)
 * from `ClepSignState` (`0x012d`) and converts it to a standard PKCS#8 PEM private key.
 * Guards against malformed lengths, non-prime/equal/even factors, modulus mismatch, and non-coprime exponents.
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

  if (
    cbPublicExp === 0 ||
    cbPublicExp > 64 ||
    cbModulus < 64 ||
    cbModulus > 1024 ||
    cbPrime1 === 0 ||
    cbPrime1 > 512 ||
    cbPrime2 === 0 ||
    cbPrime2 > 512
  ) {
    throw new Error(
      `Invalid BCRYPT_RSAKEY_BLOB field lengths (bits=${bitLength}, e=${cbPublicExp}, n=${cbModulus}, p=${cbPrime1}, q=${cbPrime2})`
    );
  }

  const needed = 24 + cbPublicExp + cbModulus + cbPrime1 + cbPrime2;
  if (blob.length < needed) {
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

  if (e <= 1n || (e & 1n) === 0n) {
    throw new Error('Invalid BCRYPT_RSAKEY_BLOB: public exponent e must be an odd integer > 1');
  }
  if (p <= 2n || q <= 2n) {
    throw new Error('Invalid BCRYPT_RSAKEY_BLOB: prime factors p and q must be > 2');
  }
  if ((p & 1n) === 0n || (q & 1n) === 0n) {
    throw new Error('Invalid BCRYPT_RSAKEY_BLOB: prime factors p and q must be odd');
  }
  if (p === q) {
    throw new Error('Invalid BCRYPT_RSAKEY_BLOB: prime factors p and q must be distinct');
  }
  if (p * q !== n) {
    throw new Error('Invalid BCRYPT_RSAKEY_BLOB: modulus n does not equal p * q');
  }
  if (gcdBigInt(q, p) !== 1n) {
    throw new Error('Invalid BCRYPT_RSAKEY_BLOB: prime factors p and q are not coprime');
  }

  const pMinus1 = p - 1n;
  const qMinus1 = q - 1n;
  const totientGcd = gcdBigInt(pMinus1, qMinus1);
  if (totientGcd <= 0n) {
    throw new Error('Invalid BCRYPT_RSAKEY_BLOB: invalid Carmichael totient');
  }
  const lambda = (pMinus1 * qMinus1) / totientGcd;
  if (lambda <= 1n || gcdBigInt(e, lambda) !== 1n) {
    throw new Error('Invalid BCRYPT_RSAKEY_BLOB: public exponent e is not coprime with lambda(n)');
  }

  const d = modInverseBigInt(e, lambda);
  const dp = d % pMinus1;
  const dq = d % qMinus1;
  const qi = modInverseBigInt(q, p);
  if (d <= 0n || dp <= 0n || dq <= 0n || qi <= 0n) {
    throw new Error('Invalid BCRYPT_RSAKEY_BLOB: derived CRT parameters must be positive');
  }

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
  const eBuf = Buffer.from(String(jwk.e || ''), 'base64url');
  const nBuf = Buffer.from(String(jwk.n || ''), 'base64url');
  const pBuf = Buffer.from(String(jwk.p || ''), 'base64url');
  const qBuf = Buffer.from(String(jwk.q || ''), 'base64url');

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

/**
 * @param {Buffer} buf16
 * @returns {string}
 */
function formatMixedEndianGuid(buf16) {
  if (!Buffer.isBuffer(buf16) || buf16.length < 16) return '';
  const d1 = buf16.readUInt32LE(0).toString(16).padStart(8, '0');
  const d2 = buf16.readUInt16LE(4).toString(16).padStart(4, '0');
  const d3 = buf16.readUInt16LE(6).toString(16).padStart(4, '0');
  const d4 = buf16.subarray(8, 10).toString('hex');
  const d5 = buf16.subarray(10, 16).toString('hex');
  return `${d1}-${d2}-${d3}-${d4}-${d5}`.toLowerCase();
}

/**
 * @param {string} guidStr
 * @returns {Buffer}
 */
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
 * NIST SP 800-108 Counter Mode KDF using `HMAC-SHA256`:
 * `[i]_32BE || Label || 0x00 || Context || [L_bits]_32BE`.
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

module.exports = {
  MAX_PARSED_RSA_PRIVATE_KEYS,
  parsedRsaPrivateKeyCache,
  hashPrivateKeyPem,
  getCachedRsaPrivateKeyObject,
  HOSTING_APP_DEFAULT_IDCRL,
  HOSTING_APP_MS_STORE,
  HOSTING_APP_TOKEN_BROKER,
  HOSTING_APP_XBOX_PC,
  HMAC_KEY_USAGE,
  LOCAL_USER_SID,
  BLOCK_ID,
  CLEP_INITIAL_STATE,
  clepObfuscate,
  clepDeobfuscate,
  deriveClepKeyFromSchedule,
  buildKeyScheduleForTargetKey,
  decryptCbcZeroIv,
  encryptCbcZeroIv,
  aes128Cmac,
  gcdBigInt,
  modInverseBigInt,
  parseBcryptRsaPrivateKeyToPem,
  exportPemToBcryptRsa2Blob,
  formatMixedEndianGuid,
  encodeMixedEndianGuid,
  aesKeyWrapRfc3394,
  aesKeyUnwrapRfc3394,
  unwrapContentCik,
  wrapContentCik,
  generateSp800108SharedKey,
  deriveDoubleDerivedHmacKey,
  unwrapClepHmacStateSecret,
};
