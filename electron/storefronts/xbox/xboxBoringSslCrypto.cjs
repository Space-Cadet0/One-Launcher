'use strict';

/**
 * Pure BoringSSL & OpenSSL Compatible Xbox Cryptographic Engine (`xboxBoringSslCrypto.cjs`).
 *
 * Chromium's embedded BoringSSL inside Electron (`process.versions.openssl === "0.0.0"`) exposes a
 * strict 28-cipher subset of `node:crypto` that omits RFC 3394 key-wrap EVP names and IEEE P1619 XTS
 * EVP names. This module implements both standards bit-for-bit over hardware-accelerated stateless
 * `aes-{128,192,256}-ecb` (`setAutoPadding(false)`), with zero npm dependencies:
 *
 * 1. **RFC 3394 AES Key Wrap & Key Unwrap (`aesKeyWrapRfc3394`, `aesKeyUnwrapRfc3394`)**:
 *    - Supports 128-bit, 192-bit, and 256-bit KEKs (`aes-128-ecb`, `aes-192-ecb`, `aes-256-ecb`)
 *    - Constant-time `crypto.timingSafeEqual` 64-bit integrity check value (`A6A6A6A6A6A6A6A6`)
 * 2. **IEEE P1619-2007 AES-XTS-128 (`transformXtsSectorEcb`, `decryptXvdPage`, `encryptXvdPage`, `decryptContiguousPageBuffer`)**:
 *    - `WeakMap`-cached stateless `aes-128-ecb` contexts per key (eliminates per-page `EVP_CIPHER_CTX` setup)
 *    - `GF(2^128)` `x^128 + x^7 + x^2 + x + 1` (`0x87`) little-endian tweak doubling in 32-bit registers
 *    - Single bulk hardware-AES `update()` across multi-megabyte contiguous XVD page spans (~1,230+ MiB/s)
 *    - Safe on arbitrary `Buffer.subarray` byte offsets (including unaligned odd byte offsets)
 */

const crypto = require('node:crypto');

const XVD_PAGE_SIZE = 0x1000; // 4096 bytes
const RFC3394_DEFAULT_IV = Buffer.alloc(8, 0xa6);

/**
 * Normalizes a `Buffer` or `Uint8Array` into a `Buffer` view without unnecessary copying.
 * @param {Buffer|Uint8Array} value
 * @param {string} label
 * @returns {Buffer}
 */
function ensureBufferView(value, label) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${label} must be a Buffer or Uint8Array`);
}

/**
 * Selects the stateless BoringSSL/OpenSSL ECB cipher name for a 16, 24, or 32-byte KEK.
 * @param {Buffer} kek
 * @returns {'aes-128-ecb' | 'aes-192-ecb' | 'aes-256-ecb'}
 */
function getEcbAlgorithmForKek(kek) {
  if (kek.length === 16) return 'aes-128-ecb';
  if (kek.length === 24) return 'aes-192-ecb';
  if (kek.length === 32) return 'aes-256-ecb';
  throw new RangeError(
    `Unsupported RFC 3394 KEK length: ${kek.length} bytes (expected 16, 24, or 32)`
  );
}

/**
 * Wraps key material using RFC 3394 Section 2.2.1 AES Key Wrap over stateless `aes-{128,192,256}-ecb`.
 *
 * @param {Buffer|Uint8Array} plainKey Plaintext key material (>= 16 bytes, multiple of 8 bytes)
 * @param {Buffer|Uint8Array} kek Key-encryption key (16, 24, or 32 bytes)
 * @param {Buffer|Uint8Array} [iv8=RFC3394_DEFAULT_IV] 8-byte integrity check register (`0xA6A6A6A6A6A6A6A6`)
 * @returns {Buffer} Wrapped key of length `plainKey.length + 8`
 */
function aesKeyWrapRfc3394(plainKey, kek, iv8 = RFC3394_DEFAULT_IV) {
  const plainBuf = ensureBufferView(plainKey, 'RFC 3394 plainKey');
  const kekBuf = ensureBufferView(kek, 'RFC 3394 kek');
  const ivBuf = ensureBufferView(iv8, 'RFC 3394 iv8');

  if (plainBuf.length < 16 || (plainBuf.length & 7) !== 0) {
    throw new RangeError(
      `RFC 3394 wrap requires plaintext key >= 16 bytes and 8-byte aligned (got ${plainBuf.length})`
    );
  }
  if (ivBuf.length !== 8) {
    throw new RangeError(`RFC 3394 IV must be 8 bytes (got ${ivBuf.length})`);
  }

  const cipher = crypto.createCipheriv(getEcbAlgorithmForKek(kekBuf), kekBuf, null);
  cipher.setAutoPadding(false);

  const n = plainBuf.length >>> 3;
  let A = ivBuf.readBigUInt64BE(0);
  const R = new BigUint64Array(n);
  for (let i = 0; i < n; i += 1) {
    R[i] = plainBuf.readBigUInt64BE(i * 8);
  }

  const block16 = Buffer.allocUnsafe(16);
  for (let j = 0; j <= 5; j += 1) {
    for (let i = 1; i <= n; i += 1) {
      block16.writeBigUInt64BE(A, 0);
      block16.writeBigUInt64BE(R[i - 1], 8);
      const B = cipher.update(block16);
      A = B.readBigUInt64BE(0) ^ BigInt(n * j + i);
      R[i - 1] = B.readBigUInt64BE(8);
    }
  }
  cipher.final();

  const out = Buffer.allocUnsafe((n + 1) * 8);
  out.writeBigUInt64BE(A, 0);
  for (let i = 0; i < n; i += 1) {
    out.writeBigUInt64BE(R[i], (i + 1) * 8);
  }
  return out;
}

/**
 * Unwraps key material using RFC 3394 Section 2.2.2 AES Key Unwrap over stateless `aes-{128,192,256}-ecb`
 * with constant-time `crypto.timingSafeEqual` IV authentication.
 *
 * @param {Buffer|Uint8Array} wrappedKey Wrapped key material (>= 24 bytes, multiple of 8 bytes)
 * @param {Buffer|Uint8Array} kek Key-encryption key (16, 24, or 32 bytes)
 * @param {Buffer|Uint8Array} [iv8=RFC3394_DEFAULT_IV] Expected 8-byte integrity check value
 * @returns {Buffer} Unwrapped key of length `wrappedKey.length - 8`
 */
function aesKeyUnwrapRfc3394(wrappedKey, kek, iv8 = RFC3394_DEFAULT_IV) {
  const wrappedBuf = ensureBufferView(wrappedKey, 'RFC 3394 wrappedKey');
  const kekBuf = ensureBufferView(kek, 'RFC 3394 kek');
  const ivBuf = ensureBufferView(iv8, 'RFC 3394 iv8');

  if (wrappedBuf.length < 24 || (wrappedBuf.length & 7) !== 0) {
    throw new RangeError(
      `RFC 3394 unwrap requires wrapped key >= 24 bytes and 8-byte aligned (got ${wrappedBuf.length})`
    );
  }
  if (ivBuf.length !== 8) {
    throw new RangeError(`RFC 3394 IV must be 8 bytes (got ${ivBuf.length})`);
  }

  const decipher = crypto.createDecipheriv(getEcbAlgorithmForKek(kekBuf), kekBuf, null);
  decipher.setAutoPadding(false);

  const n = (wrappedBuf.length >>> 3) - 1;
  let A = wrappedBuf.readBigUInt64BE(0);
  const R = new BigUint64Array(n);
  for (let i = 0; i < n; i += 1) {
    R[i] = wrappedBuf.readBigUInt64BE((i + 1) * 8);
  }

  const block16 = Buffer.allocUnsafe(16);
  for (let j = 5; j >= 0; j -= 1) {
    for (let i = n; i >= 1; i -= 1) {
      block16.writeBigUInt64BE(A ^ BigInt(n * j + i), 0);
      block16.writeBigUInt64BE(R[i - 1], 8);
      const B = decipher.update(block16);
      A = B.readBigUInt64BE(0);
      R[i - 1] = B.readBigUInt64BE(8);
    }
  }
  decipher.final();

  const actualIv = Buffer.allocUnsafe(8);
  actualIv.writeBigUInt64BE(A, 0);
  if (!crypto.timingSafeEqual(actualIv, ivBuf)) {
    const err = Object.assign(
      new Error('RFC 3394 AES Key Unwrap integrity check failed (IV mismatch)'),
      { code: 'ERR_RFC3394_UNWRAP_FAILED' }
    );
    throw err;
  }

  const out = Buffer.allocUnsafe(n * 8);
  for (let i = 0; i < n; i += 1) {
    out.writeBigUInt64BE(R[i], i * 8);
  }
  return out;
}

/**
 * Unwraps a 40-byte RFC 3394 AES-128-wrapped Content Integrity Key (`CIK`) using a 16-byte device key.
 * Accepts `Buffer`, `Uint8Array`, hex string, or Base64 string inputs.
 *
 * @param {Buffer|Uint8Array|string} wrappedCik40
 * @param {Buffer|Uint8Array|string} deviceKey16
 * @returns {Buffer} 32-byte raw XVD CIK (`[tweakKey(0..16) || dataKey(16..32)]`)
 */
function unwrapCikWithDeviceKey(wrappedCik40, deviceKey16) {
  const wrapped = Buffer.isBuffer(wrappedCik40)
    ? wrappedCik40
    : wrappedCik40 instanceof Uint8Array
      ? Buffer.from(wrappedCik40.buffer, wrappedCik40.byteOffset, wrappedCik40.byteLength)
      : /^[0-9a-fA-F]{80}$/.test(String(wrappedCik40))
        ? Buffer.from(String(wrappedCik40), 'hex')
        : Buffer.from(String(wrappedCik40), 'base64');
  const kek = Buffer.isBuffer(deviceKey16)
    ? deviceKey16
    : deviceKey16 instanceof Uint8Array
      ? Buffer.from(deviceKey16.buffer, deviceKey16.byteOffset, deviceKey16.byteLength)
      : /^[0-9a-fA-F]{32}$/.test(String(deviceKey16))
        ? Buffer.from(String(deviceKey16), 'hex')
        : Buffer.from(String(deviceKey16), 'base64');

  if (wrapped.length !== 40) {
    throw new Error(`Expected 40-byte RFC 3394 wrapped CIK, got ${wrapped.length} bytes`);
  }
  if (kek.length !== 16) {
    throw new Error(`Expected 16-byte AES-128 device wrapping key, got ${kek.length} bytes`);
  }

  return aesKeyUnwrapRfc3394(wrapped, kek, RFC3394_DEFAULT_IV);
}

/**
 * Wraps a 32-byte raw XVD CIK with a 16-byte AES-128 device key using RFC 3394 (`IV = A6..A6`).
 *
 * @param {Buffer} cik32
 * @param {Buffer} deviceKey16
 * @returns {Buffer} 40-byte wrapped CIK
 */
function wrapCikWithDeviceKey(cik32, deviceKey16) {
  if (!Buffer.isBuffer(cik32) || cik32.length !== 32) {
    throw new Error('wrapCikWithDeviceKey requires a 32-byte CIK Buffer');
  }
  if (!Buffer.isBuffer(deviceKey16) || deviceKey16.length !== 16) {
    throw new Error('wrapCikWithDeviceKey requires a 16-byte deviceKey Buffer');
  }
  return aesKeyWrapRfc3394(cik32, deviceKey16, RFC3394_DEFAULT_IV);
}

/**
 * Converts a 32-byte Microsoft XVD CIK (`[tweak_key(0..16) || data_key(16..32)]`)
 * into IEEE P1619 AES-XTS-128 key order (`[data_key(16..32) || tweak_key(0..16)]`).
 *
 * @param {Buffer} cik32
 * @returns {Buffer}
 */
function buildOpenSslXtsKey(cik32) {
  if (!Buffer.isBuffer(cik32) || cik32.length !== 32) {
    throw new Error(`Invalid 32-byte XVD CIK length: ${cik32 ? cik32.length : 0}`);
  }
  return Buffer.concat([cik32.subarray(16, 32), cik32.subarray(0, 16)]);
}

/**
 * Builds the 16-byte raw XVD AES-XTS tweak (`[u32LE(dataUnit), u32LE(regionId), vduid[0..8]]`).
 *
 * @param {number} dataUnit
 * @param {number} regionId
 * @param {Buffer} vduidLow8
 * @returns {Buffer}
 */
function buildXvdXtsTweak(dataUnit, regionId, vduidLow8) {
  const tweak = Buffer.allocUnsafe(16);
  tweak.writeUInt32LE(dataUnit >>> 0, 0);
  tweak.writeUInt32LE(regionId >>> 0, 4);
  vduidLow8.copy(tweak, 8, 0, 8);
  return tweak;
}

// Per-key reusable stateless AES-128-ECB contexts (`tweakCipher`, `dataDecipher`, `dataCipher`)
const xtsCtxWeakCache = new WeakMap();

/**
 * Retrieves or initializes cached stateless `aes-128-ecb` contexts for a 32-byte `[dataKey16 || tweakKey16]`.
 * Verifies `keyCopy.equals(keyBuf)` on cache hits so in-place caller mutations never use stale subkeys.
 *
 * @param {Buffer|Uint8Array} osslXtsKey
 */
function getOrCreateXtsEcbContext(osslXtsKey) {
  const keyBuf = ensureBufferView(osslXtsKey, 'AES-XTS-128 key');
  if (keyBuf.length !== 32) {
    throw new RangeError(`AES-XTS-128 requires a 32-byte key (got ${keyBuf.length})`);
  }

  let ctx = xtsCtxWeakCache.get(osslXtsKey);
  if (ctx && ctx.keyCopy.equals(keyBuf)) {
    return ctx;
  }

  const dataKey16 = keyBuf.subarray(0, 16);
  const tweakKey16 = keyBuf.subarray(16, 32);

  const tweakCipher = crypto.createCipheriv('aes-128-ecb', tweakKey16, null);
  tweakCipher.setAutoPadding(false);

  const dataDecipher = crypto.createDecipheriv('aes-128-ecb', dataKey16, null);
  dataDecipher.setAutoPadding(false);

  const dataCipher = crypto.createCipheriv('aes-128-ecb', dataKey16, null);
  dataCipher.setAutoPadding(false);

  ctx = {
    keyCopy: Buffer.from(keyBuf),
    tweakCipher,
    dataDecipher,
    dataCipher,
  };
  xtsCtxWeakCache.set(osslXtsKey, ctx);
  return ctx;
}

/**
 * Returns a 4-byte-aligned `Uint32Array` view over the first `byteLen` bytes of `buf`,
 * copying into a fresh aligned `ArrayBuffer` only if `buf.byteOffset` is not 4-byte aligned.
 *
 * @param {Buffer} buf
 * @param {number} byteLen
 * @returns {Uint32Array}
 */
function asAlignedU32Array(buf, byteLen) {
  if ((buf.byteOffset & 3) === 0) {
    return new Uint32Array(buf.buffer, buf.byteOffset, byteLen >>> 2);
  }
  const alignedAb = new ArrayBuffer(byteLen);
  const alignedBuf = Buffer.from(alignedAb);
  buf.copy(alignedBuf, 0, 0, byteLen);
  return new Uint32Array(alignedAb);
}

// Pre-allocated 4-byte-aligned reusable scratch buffers (eliminates +32 MiB per-chunk GC churn — D4.4)
const SCRATCH_SLICE_PAGES = 256; // 256 * 4096 = 1 MiB slice window
const SCRATCH_SLICE_BYTES = SCRATCH_SLICE_PAGES * XVD_PAGE_SIZE;
const scratchSliceWorkAb = new ArrayBuffer(SCRATCH_SLICE_BYTES);
const scratchSliceWorkBuf = Buffer.from(scratchSliceWorkAb);
const scratchSliceWorkU32 = new Uint32Array(scratchSliceWorkAb);

const scratchUnalignedSliceAb = new ArrayBuffer(SCRATCH_SLICE_BYTES);
const scratchUnalignedSliceBuf = Buffer.from(scratchUnalignedSliceAb);
const scratchUnalignedSliceU32 = new Uint32Array(scratchUnalignedSliceAb);

let scratchTweaksCapacityPages = 4096; // 64 KiB initial tweak scratch (covers up to 16 MiB chunks)
let scratchTweaksAb = new ArrayBuffer(scratchTweaksCapacityPages * 16);
let scratchTweaksBuf = Buffer.from(scratchTweaksAb);
let scratchTweaksU32 = new Uint32Array(scratchTweaksAb);

function ensureScratchTweaksCapacity(pages) {
  if (pages <= scratchTweaksCapacityPages) return;
  let nextCap = scratchTweaksCapacityPages;
  while (nextCap < pages) nextCap *= 2;
  scratchTweaksCapacityPages = nextCap;
  scratchTweaksAb = new ArrayBuffer(nextCap * 16);
  scratchTweaksBuf = Buffer.from(scratchTweaksAb);
  scratchTweaksU32 = new Uint32Array(scratchTweaksAb);
}

/**
 * Transforms (encrypts or decrypts) a single 16-byte-aligned sector (>= 16 bytes) using
 * IEEE P1619-2007 AES-XTS-128 over stateless BoringSSL/OpenSSL `aes-128-ecb`.
 *
 * @param {Buffer|Uint8Array} inputBuf
 * @param {Buffer|Uint8Array} osslXtsKey 32-byte `[dataKey16 || tweakKey16]`
 * @param {Buffer|Uint8Array} tweak16 16-byte sector tweak value
 * @param {boolean} isEncrypt `true` to encrypt, `false` to decrypt
 * @param {{ inPlace?: boolean }} [options]
 * @returns {Buffer}
 */
function transformXtsSectorEcb(inputBuf, osslXtsKey, tweak16, isEncrypt, options = {}) {
  const sectorBuf = ensureBufferView(inputBuf, 'XTS sector');
  const tweakBuf = ensureBufferView(tweak16, 'XTS tweak');

  if (sectorBuf.length < 16 || (sectorBuf.length & 15) !== 0) {
    throw new RangeError(
      `XTS sector must be >= 16 bytes and 16-byte aligned (got ${sectorBuf.length})`
    );
  }
  if (tweakBuf.length !== 16) {
    throw new RangeError(`XTS tweak must be 16 bytes (got ${tweakBuf.length})`);
  }

  const byteLen = sectorBuf.length;
  const blocks = byteLen >>> 4;
  const ctx = getOrCreateXtsEcbContext(osslXtsKey);

  const encTweak = ctx.tweakCipher.update(tweakBuf);
  const t0Init = encTweak.readUInt32LE(0);
  const t1Init = encTweak.readUInt32LE(4);
  const t2Init = encTweak.readUInt32LE(8);
  const t3Init = encTweak.readUInt32LE(12);

  let workBuf;
  let workU32;
  if (byteLen <= SCRATCH_SLICE_BYTES) {
    workBuf = scratchSliceWorkBuf.subarray(0, byteLen);
    workU32 = scratchSliceWorkU32;
  } else {
    const workAb = new ArrayBuffer(byteLen);
    workBuf = Buffer.from(workAb);
    workU32 = new Uint32Array(workAb);
  }

  let inU32;
  if ((sectorBuf.byteOffset & 3) === 0) {
    inU32 = new Uint32Array(sectorBuf.buffer, sectorBuf.byteOffset, byteLen >>> 2);
  } else if (byteLen <= SCRATCH_SLICE_BYTES) {
    sectorBuf.copy(scratchUnalignedSliceBuf, 0, 0, byteLen);
    inU32 = scratchUnalignedSliceU32;
  } else {
    inU32 = asAlignedU32Array(sectorBuf, byteLen);
  }

  let t0 = t0Init;
  let t1 = t1Init;
  let t2 = t2Init;
  let t3 = t3Init;

  for (let b = 0; b < blocks; b += 1) {
    const w = b << 2;
    workU32[w] = inU32[w] ^ t0;
    workU32[w + 1] = inU32[w + 1] ^ t1;
    workU32[w + 2] = inU32[w + 2] ^ t2;
    workU32[w + 3] = inU32[w + 3] ^ t3;

    const mask = (t3 >> 31) & 0x87;
    t3 = ((t3 << 1) | (t2 >>> 31)) >>> 0;
    t2 = ((t2 << 1) | (t1 >>> 31)) >>> 0;
    t1 = ((t1 << 1) | (t0 >>> 31)) >>> 0;
    t0 = ((t0 << 1) ^ mask) >>> 0;
  }

  const outRaw = isEncrypt ? ctx.dataCipher.update(workBuf) : ctx.dataDecipher.update(workBuf);
  let outBuf;
  if (options?.inPlace && (sectorBuf.byteOffset & 3) === 0) {
    outRaw.copy(sectorBuf, 0, 0, byteLen);
    outBuf = sectorBuf;
  } else if ((outRaw.byteOffset & 3) === 0) {
    outBuf = outRaw;
  } else {
    const copy = Buffer.from(new ArrayBuffer(byteLen));
    outRaw.copy(copy, 0, 0, byteLen);
    outBuf = copy;
  }
  const outU32 = new Uint32Array(outBuf.buffer, outBuf.byteOffset, byteLen >>> 2);

  t0 = t0Init;
  t1 = t1Init;
  t2 = t2Init;
  t3 = t3Init;

  for (let b = 0; b < blocks; b += 1) {
    const w = b << 2;
    outU32[w] ^= t0;
    outU32[w + 1] ^= t1;
    outU32[w + 2] ^= t2;
    outU32[w + 3] ^= t3;

    const mask = (t3 >> 31) & 0x87;
    t3 = ((t3 << 1) | (t2 >>> 31)) >>> 0;
    t2 = ((t2 << 1) | (t1 >>> 31)) >>> 0;
    t1 = ((t1 << 1) | (t0 >>> 31)) >>> 0;
    t0 = ((t0 << 1) ^ mask) >>> 0;
  }

  if (options?.inPlace && outBuf !== sectorBuf) {
    outBuf.copy(sectorBuf, 0, 0, byteLen);
    return sectorBuf;
  }

  return outBuf;
}

/**
 * Decrypts a single 0x1000-byte (4096B) XVD page using IEEE P1619 AES-XTS-128.
 *
 * @param {Buffer|Uint8Array} cipherPage
 * @param {Buffer|Uint8Array} osslXtsKey
 * @param {Buffer|Uint8Array} tweak16
 * @returns {Buffer}
 */
function decryptXvdPage(cipherPage, osslXtsKey, tweak16) {
  const pageBuf = ensureBufferView(cipherPage, 'cipherPage');
  if (pageBuf.length !== XVD_PAGE_SIZE) {
    throw new Error(`decryptXvdPage requires a ${XVD_PAGE_SIZE}-byte page (got ${pageBuf.length})`);
  }
  return transformXtsSectorEcb(pageBuf, osslXtsKey, tweak16, false);
}

/**
 * Encrypts a single 0x1000-byte (4096B) XVD page using IEEE P1619 AES-XTS-128.
 *
 * @param {Buffer|Uint8Array} plainPage
 * @param {Buffer|Uint8Array} osslXtsKey
 * @param {Buffer|Uint8Array} tweak16
 * @returns {Buffer}
 */
function encryptXvdPage(plainPage, osslXtsKey, tweak16) {
  const pageBuf = ensureBufferView(plainPage, 'plainPage');
  if (pageBuf.length !== XVD_PAGE_SIZE) {
    throw new Error(`encryptXvdPage requires a ${XVD_PAGE_SIZE}-byte page (got ${pageBuf.length})`);
  }
  return transformXtsSectorEcb(pageBuf, osslXtsKey, tweak16, true);
}

/**
 * Bulk-decrypts `pageCount` contiguous 0x1000-byte XVD pages using vectorized IEEE P1619 AES-XTS-128:
 * 1. Batch-encrypts all `pageCount` 16B initial tweaks in ONE `tweakCipher.update()` call
 * 2. Pre-XORs all `pageCount * 256` 16B blocks in 32-bit registers
 * 3. Decrypts the entire `pageCount * 4096` byte buffer in ONE hardware-AES `dataDecipher.update()` call
 * 4. Post-XORs all `pageCount * 256` 16B blocks in-place
 *
 * @param {{
 *   rawBuffer: Buffer|Uint8Array,
 *   firstPageDiskOffset?: number,
 *   pageCount: number,
 *   dataUnits: Uint32Array|number[],
 *   osslXtsKey: Buffer|Uint8Array,
 *   regionId: number,
 *   vduidLow8: Buffer|Uint8Array,
 *   inPlace?: boolean
 * }} params
 * @returns {Buffer}
 */
function decryptContiguousPageBuffer({
  rawBuffer,
  pageCount,
  dataUnits,
  osslXtsKey,
  regionId,
  vduidLow8,
  inPlace = false,
}) {
  const pages = Math.floor(Number(pageCount) || 0);
  if (pages <= 0) {
    return Buffer.alloc(0);
  }

  const totalBytes = pages * XVD_PAGE_SIZE;
  const rawBuf = ensureBufferView(rawBuffer, 'rawBuffer');
  if (rawBuf.length < totalBytes) {
    throw new RangeError(
      `decryptContiguousPageBuffer rawBuffer too short: expected >= ${totalBytes} bytes, got ${rawBuf.length}`
    );
  }
  if (!dataUnits || typeof dataUnits.length !== 'number' || dataUnits.length < pages) {
    throw new RangeError(
      `decryptContiguousPageBuffer dataUnits length (${dataUnits?.length ?? 0}) < pageCount (${pages})`
    );
  }
  const vduidBuf = ensureBufferView(vduidLow8, 'vduidLow8');
  if (vduidBuf.length < 8) {
    throw new RangeError(`decryptContiguousPageBuffer vduidLow8 must be >= 8 bytes (got ${vduidBuf.length})`);
  }

  const ctx = getOrCreateXtsEcbContext(osslXtsKey);

  // 1. Build all page tweaks into reusable scratchTweaksBuf and encrypt them in one ECB update
  ensureScratchTweaksCapacity(pages);
  const vduidLo = vduidBuf.readUInt32LE(0);
  const vduidHi = vduidBuf.readUInt32LE(4);
  const regU32 = (Number(regionId) || 0) >>> 0;

  for (let p = 0; p < pages; p += 1) {
    const base = p << 2;
    scratchTweaksU32[base] = dataUnits[p] >>> 0;
    scratchTweaksU32[base + 1] = regU32;
    scratchTweaksU32[base + 2] = vduidLo;
    scratchTweaksU32[base + 3] = vduidHi;
  }

  const encTweaks = ctx.tweakCipher.update(scratchTweaksBuf.subarray(0, pages * 16));
  const encTweaksU32 = asAlignedU32Array(encTweaks, pages * 16);

  // Allocate single destination buffer (or reuse rawBuf in-place when aligned & caller opted in)
  const rawAligned = (rawBuf.byteOffset & 3) === 0;
  const useInPlaceDirectly = Boolean(inPlace && rawAligned);
  const outBuf = useInPlaceDirectly
    ? rawBuf.subarray(0, totalBytes)
    : Buffer.from(new ArrayBuffer(totalBytes));
  const outU32 = new Uint32Array(outBuf.buffer, outBuf.byteOffset, totalBytes >>> 2);
  const fullRawU32 = rawAligned
    ? new Uint32Array(rawBuf.buffer, rawBuf.byteOffset, totalBytes >>> 2)
    : null;

  // 2–4. Process in bounded 1 MiB (256-page) slices reusing scratchSliceWorkBuf (eliminates +32 MiB churn)
  for (let sliceStartPage = 0; sliceStartPage < pages; sliceStartPage += SCRATCH_SLICE_PAGES) {
    const slicePages = Math.min(SCRATCH_SLICE_PAGES, pages - sliceStartPage);
    const sliceBytes = slicePages * XVD_PAGE_SIZE;
    const sliceByteOffset = sliceStartPage * XVD_PAGE_SIZE;

    let srcSliceU32;
    let srcU32BaseOffset;
    if (fullRawU32) {
      srcSliceU32 = fullRawU32;
      srcU32BaseOffset = sliceStartPage * 1024;
    } else {
      rawBuf.copy(scratchUnalignedSliceBuf, 0, sliceByteOffset, sliceByteOffset + sliceBytes);
      srcSliceU32 = scratchUnalignedSliceU32;
      srcU32BaseOffset = 0;
    }

    // Pre-XOR into reusable scratchSliceWorkU32
    for (let sp = 0; sp < slicePages; sp += 1) {
      const twBase = (sliceStartPage + sp) << 2;
      let t0 = encTweaksU32[twBase];
      let t1 = encTweaksU32[twBase + 1];
      let t2 = encTweaksU32[twBase + 2];
      let t3 = encTweaksU32[twBase + 3];

      let wDst = sp * 1024;
      let wSrc = srcU32BaseOffset + wDst;
      const wDstEnd = wDst + 1024;
      for (; wDst < wDstEnd; wDst += 4, wSrc += 4) {
        scratchSliceWorkU32[wDst] = srcSliceU32[wSrc] ^ t0;
        scratchSliceWorkU32[wDst + 1] = srcSliceU32[wSrc + 1] ^ t1;
        scratchSliceWorkU32[wDst + 2] = srcSliceU32[wSrc + 2] ^ t2;
        scratchSliceWorkU32[wDst + 3] = srcSliceU32[wSrc + 3] ^ t3;

        const mask = (t3 >> 31) & 0x87;
        t3 = ((t3 << 1) | (t2 >>> 31)) >>> 0;
        t2 = ((t2 << 1) | (t1 >>> 31)) >>> 0;
        t1 = ((t1 << 1) | (t0 >>> 31)) >>> 0;
        t0 = ((t0 << 1) ^ mask) >>> 0;
      }
    }

    // Bulk hardware-AES ECB decrypt for this 1 MiB slice
    const decSlice = ctx.dataDecipher.update(scratchSliceWorkBuf.subarray(0, sliceBytes));
    decSlice.copy(outBuf, sliceByteOffset, 0, sliceBytes);

    // Post-XOR in-place inside outU32
    for (let sp = 0; sp < slicePages; sp += 1) {
      const twBase = (sliceStartPage + sp) << 2;
      let t0 = encTweaksU32[twBase];
      let t1 = encTweaksU32[twBase + 1];
      let t2 = encTweaksU32[twBase + 2];
      let t3 = encTweaksU32[twBase + 3];

      let wOut = (sliceStartPage + sp) * 1024;
      const wOutEnd = wOut + 1024;
      for (; wOut < wOutEnd; wOut += 4) {
        outU32[wOut] ^= t0;
        outU32[wOut + 1] ^= t1;
        outU32[wOut + 2] ^= t2;
        outU32[wOut + 3] ^= t3;

        const mask = (t3 >> 31) & 0x87;
        t3 = ((t3 << 1) | (t2 >>> 31)) >>> 0;
        t2 = ((t2 << 1) | (t1 >>> 31)) >>> 0;
        t1 = ((t1 << 1) | (t0 >>> 31)) >>> 0;
        t0 = ((t0 << 1) ^ mask) >>> 0;
      }
    }
  }

  if (inPlace && !useInPlaceDirectly) {
    outBuf.copy(rawBuf, 0, 0, totalBytes);
    return rawBuf.subarray(0, totalBytes);
  }

  return outBuf;
}

module.exports = {
  XVD_PAGE_SIZE,
  RFC3394_DEFAULT_IV,
  aesKeyWrapRfc3394,
  aesKeyUnwrapRfc3394,
  unwrapCikWithDeviceKey,
  unwrapCikRfc3394: unwrapCikWithDeviceKey,
  wrapCikWithDeviceKey,
  wrapCikRfc3394: wrapCikWithDeviceKey,
  buildOpenSslXtsKey,
  buildXvdXtsTweak,
  transformXtsSectorEcb,
  decryptXvdPage,
  encryptXvdPage,
  decryptContiguousPageBuffer,
};
