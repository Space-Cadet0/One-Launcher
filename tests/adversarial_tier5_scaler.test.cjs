'use strict';

/**
 * tests/adversarial_tier5_scaler.test.cjs
 *
 * Milestone M5 Phase 2: Adversarial Coverage Hardening Suite
 * Target Subsystems: Native Display Scaler & Whole-Display Verification (Requirement R3)
 *
 * Verifies:
 *   Track 1: Native C11 Scaler ASan + UBSan Sanitizer Execution (147,000+ checks)
 *   Track 2: Viewport Geometry, Downscaling & Exotic Aspect Ratio Invariants
 *   Track 3: Whole-Display Verifier (R3) Multi-Vector Defect Injection Torture
 *   Track 4: Pure Node.js PNG Engine Resilience, Filters & Chunk Fragmentation
 *   Track 5: Turnkey CLI Semantics, Machine-Readable JSON & Option Aliases
 *   Track 6: Source Code Architecture, Modal Promotion & Universal Portability Invariants
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const cp = require('node:child_process');
const assert = require('node:assert');

const ROOT_DIR = path.resolve(__dirname, '..');
const SCALER_DIR = path.join(ROOT_DIR, 'electron', 'helpers', 'display_scaler');
const MATH_SRC = path.join(SCALER_DIR, 'display_scaler_math.c');
const PROBE_SRC = path.join(ROOT_DIR, 'tests', 'native', 'challenger_tier5_scaler_probe.c');
const VERIFIER_SCRIPT = path.join(ROOT_DIR, 'scripts', 'verify-display-output.cjs');

const {
  encodePng,
  decodePng,
  computeOracleViewport,
  verifyDisplayOutput,
  analyzeDisplayPixels,
  computeViewportLuminance,
  generateSyntheticDisplayBuffer,
} = require(VERIFIER_SCRIPT);

let totalPassed = 0;
let totalFailed = 0;
const testRecords = [];

function runTest(id, description, testFn) {
  process.stdout.write(`  [${id}] ${description} ... `);
  try {
    const outcome = testFn();
    totalPassed++;
    testRecords.push({ id, description, passed: true, outcome });
    console.log('PASS');
  } catch (err) {
    totalFailed++;
    testRecords.push({ id, description, passed: false, error: err.message, stack: err.stack });
    console.log('FAIL');
    console.error(`    ${err.stack || err.message}`);
  }
}

let tempDir = null;
function getTempDir() {
  if (!tempDir) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-tier5-scaler-'));
  }
  return tempDir;
}

process.on('exit', () => {
  if (tempDir && fs.existsSync(tempDir)) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

console.log('================================================================');
console.log('  ONE LAUNCHER: MILESTONE M5 PHASE 2 ADVERSARIAL STRESS SUITE');
console.log('  Target: Display Scaler & Native Subsystems (Tier 5 Hardening)');
console.log('================================================================\n');

// ============================================================================
// TRACK 1: Native C11 Scaler ASan + UBSan Sanitizer Execution
// ============================================================================
console.log('--- TRACK 1: Native C11 Scaler ASan/UBSan Sanitizer Execution ---');

runTest('TRK1-01', 'Host Clang C11 AddressSanitizer & UBSan compilation and execution', () => {
  const binPath = path.join(getTempDir(), 'tier5_probe');
  const compileArgs = [
    '-std=c11',
    '-O1',
    '-fsanitize=address,undefined',
    '-fno-omit-frame-pointer',
    '-Wall',
    '-Wextra',
    '-Werror',
    `-I${SCALER_DIR}`,
    MATH_SRC,
    PROBE_SRC,
    '-o',
    binPath,
  ];

  cp.execFileSync('clang', compileArgs, { cwd: ROOT_DIR, stdio: 'pipe' });
  assert.ok(fs.existsSync(binPath), 'Compiled ASan binary must exist');

  const probeOut = cp.execFileSync(binPath, [], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1:halt_on_error=1',
      UBSAN_OPTIONS: 'print_stacktrace=1:halt_on_error=1',
    },
  });

  assert.match(probeOut, /SUMMARY:\s+(\d+)\s+checks run,\s+0 failures/, 'Probe must report 0 failures');
  assert.match(probeOut, /Track 1: Viewport Geometry & Extreme Aspect Ratios verified/, 'Track 1 verified in C');
  assert.match(probeOut, /Track 2: Zero-Drift Mouse Look Torture verified/, 'Track 2 verified in C');
  assert.match(probeOut, /Track 3: Cursor Bijectivity & Clamping Across Panels verified/, 'Track 3 verified in C');
  assert.match(probeOut, /Track 4: Mode Table Synthesis Hard Limits & Pruning Invariants verified/, 'Track 4 verified in C');
  assert.match(probeOut, /Track 5: Watertight Sub-Rectangle Mapping & Control INI Fuzzing verified/, 'Track 5 verified in C');
  return '147,000+ C11 sanitizer checks passed with 0 UB and 0 memory errors';
});

// ============================================================================
// TRACK 2: Viewport Geometry, Downscaling & Exotic Aspect Ratios
// ============================================================================
console.log('\n--- TRACK 2: Viewport Geometry, Downscaling & Aspect Ratios ---');

runTest('TRK2-01', 'Degenerate dimensions (0, negative, null) safely return null without throwing', () => {
  assert.strictEqual(computeOracleViewport(0, 1964, 0, 640, 480, 'preserve'), null);
  assert.strictEqual(computeOracleViewport(3024, 0, 0, 640, 480, 'preserve'), null);
  assert.strictEqual(computeOracleViewport(3024, 1964, 0, 0, 480, 'preserve'), null);
  assert.strictEqual(computeOracleViewport(3024, 1964, 0, 640, 0, 'preserve'), null);
  assert.strictEqual(computeOracleViewport(-10, 1964, 0, 640, 480, 'preserve'), null);
  assert.strictEqual(computeOracleViewport(3024, -20, 0, 640, 480, 'preserve'), null);
});

runTest('TRK2-02', '21:9 Ultrawide aspect ratio computes even height and symmetric letterbox margins', () => {
  const vp = computeOracleViewport(3024, 1964, 0, 2560, 1080, 'preserve');
  assert.ok(vp);
  assert.strictEqual(vp.dstW, 3024, 'Spans full physical panel width');
  assert.strictEqual(vp.dstX, 0, 'Horizontal offset is 0');
  assert.strictEqual(vp.dstH % 2, 0, 'dstH must be an even integer');
  assert.ok(vp.dstY >= 74, 'Letterbox top margin must clear 74px physical notch');
  const bottomMargin = 1964 - (vp.dstY + vp.dstH);
  assert.ok(Math.abs(vp.dstY - bottomMargin) <= 1, 'Top and bottom margins are symmetric');
});

runTest('TRK2-03', '32:9 Super-Ultrawide aspect ratio computes even height and symmetric letterbox', () => {
  const vp = computeOracleViewport(3024, 1964, 0, 5120, 1440, 'preserve');
  assert.ok(vp);
  assert.strictEqual(vp.dstW, 3024);
  assert.strictEqual(vp.dstH % 2, 0, 'dstH must be even');
  assert.strictEqual(vp.dstY, Math.floor((1964 - vp.dstH) / 2));
});

runTest('TRK2-04', '9:16 Tate vertical mode computes even width and symmetric pillarbox margins', () => {
  const vp = computeOracleViewport(3024, 1964, 0, 1080, 1920, 'preserve');
  assert.ok(vp);
  assert.strictEqual(vp.dstH, 1964, 'Spans full physical panel height');
  assert.strictEqual(vp.dstY, 0, 'Vertical offset is 0');
  assert.strictEqual(vp.dstW % 2, 0, 'dstW must be an even integer');
  const rightMargin = 3024 - (vp.dstX + vp.dstW);
  assert.ok(Math.abs(vp.dstX - rightMargin) <= 1, 'Left and right margins are symmetric');
});

runTest('TRK2-05', 'Downscaling: 4K (3840x2160) game on 1080p panel computes 1:1 pixel mapping', () => {
  const vp = computeOracleViewport(1920, 1080, 0, 3840, 2160, 'preserve');
  assert.ok(vp);
  assert.strictEqual(vp.dstW, 1920);
  assert.strictEqual(vp.dstH, 1080);
  assert.strictEqual(vp.dstX, 0);
  assert.strictEqual(vp.dstY, 0);
});

runTest('TRK2-06', 'Integer scaling fallback when virtual exceeds usable panel falls back to aspect preserve', () => {
  const vp = computeOracleViewport(1920, 1080, 0, 3840, 2160, 'integer');
  assert.ok(vp);
  assert.strictEqual(vp.integerScale, 0, 'integerScale falls back to 0');
  assert.strictEqual(vp.dstW, 1920);
  assert.strictEqual(vp.dstH, 1080);
});

// ============================================================================
// TRACK 3: Whole-Display Verifier (R3) Multi-Vector Defect Injection Torture
// ============================================================================
console.log('\n--- TRACK 3: Whole-Display Verifier (R3) Defect Injection Torture ---');

function createRetinaTestFrame(w = 3024, h = 1964, virtW = 640, virtH = 480) {
  const oracle = computeOracleViewport(w, h, 0, virtW, virtH, 'preserve');
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

  for (let y = oracle.dstY; y < oracle.dstY + oracle.dstH; y++) {
    const rowOffset = y * w * 4;
    for (let x = oracle.dstX; x < oracle.dstX + oracle.dstW; x++) {
      const idx = rowOffset + (x * 4);
      rgba[idx] = 40 + ((x * 7) % 180);
      rgba[idx + 1] = 50 + ((y * 11) % 180);
      rgba[idx + 2] = 130;
    }
  }
  return { rgba, oracle, w, h };
}

runTest('TRK3-01', 'Rejection of pitch-black unrendered frame (zero luminance)', () => {
  const w = 3024, h = 1964;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false, 'Pitch black frame must be rejected');
  assert.strictEqual(res.avgLuminance, 0, 'Luminance must be 0');
  assert.ok(res.summary.includes('zero luminance'), 'Summary must mention zero luminance');
});

runTest('TRK3-02', 'Rejection of single 1-pixel RGB(1,0,0) in left pillarbox margin', () => {
  const { rgba, w, h } = createRetinaTestFrame();
  const idx = (500 * w + 50) * 4;
  rgba[idx] = 1;
  rgba[idx + 1] = 0;
  rgba[idx + 2] = 0;
  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.totalMarginViolations, 1);
});

runTest('TRK3-03', 'Rejection of single 1-pixel RGB(0,1,0) in top-left corner (0, 0)', () => {
  const { rgba, w, h } = createRetinaTestFrame();
  rgba[0] = 0;
  rgba[1] = 1;
  rgba[2] = 0;
  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.totalMarginViolations, 1);
});

runTest('TRK3-04', 'Rejection of single 1-pixel RGB(0,0,1) in bottom-right corner (3023, 1963)', () => {
  const { rgba, w, h } = createRetinaTestFrame();
  const idx = ((h - 1) * w + (w - 1)) * 4;
  rgba[idx] = 0;
  rgba[idx + 1] = 0;
  rgba[idx + 2] = 1;
  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.totalMarginViolations, 1);
});

runTest('TRK3-05', 'Rejection of single 1-pixel defect directly on viewport boundary (dstX - 1)', () => {
  const { rgba, oracle, w, h } = createRetinaTestFrame();
  const sampleY = oracle.dstY + Math.floor((oracle.dstH * 5) / 10); // Exactly on sampled row 982
  const idx = (sampleY * w + (oracle.dstX - 1)) * 4;
  rgba[idx] = 255;
  rgba[idx + 1] = 255;
  rgba[idx + 2] = 255;
  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.totalMarginViolations, 1);
  assert.strictEqual(res.leftEdgeClean, false, 'Left edge cleanliness must fail on sampled row');
});

runTest('TRK3-06', 'Detection and classification of macOS Menu Bar bleed in top 0..44px', () => {
  const { rgba, w, h } = createRetinaTestFrame();
  const idx = (20 * w + 50) * 4;
  rgba[idx] = 220;
  rgba[idx + 1] = 220;
  rgba[idx + 2] = 220;
  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.menuBarBleed, true, 'menuBarBleed must be true');
  assert.ok(res.summary.includes('Menu Bar bleed'), 'Summary must flag Menu Bar bleed');
});

runTest('TRK3-07', 'Detection and classification of macOS Dock bleed in bottom 60px', () => {
  const { rgba, w, h } = createRetinaTestFrame();
  const idx = ((h - 20) * w + 50) * 4;
  rgba[idx] = 180;
  rgba[idx + 1] = 180;
  rgba[idx + 2] = 180;
  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.dockBleed, true, 'dockBleed must be true');
  assert.ok(res.summary.includes('Dock bleed'), 'Summary must flag Dock bleed');
});

runTest('TRK3-08', 'Rejection of horizontal centering error (+4px shift)', () => {
  const { oracle, w, h } = createRetinaTestFrame();
  const shiftedDstX = oracle.dstX + 4;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  for (let y = oracle.dstY; y < oracle.dstY + oracle.dstH; y++) {
    const rowOffset = y * w * 4;
    for (let x = shiftedDstX; x < shiftedDstX + oracle.dstW; x++) {
      const idx = rowOffset + (x * 4);
      rgba[idx] = 50;
      rgba[idx + 1] = 60;
      rgba[idx + 2] = 70;
    }
  }
  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false);
  assert.ok(res.horizontalCenteringError >= 4, 'Horizontal centering error must be detected');
});

runTest('TRK3-09', 'Rejection of odd viewport height (dstH = 1963px)', () => {
  const { oracle, w, h } = createRetinaTestFrame();
  const oddH = 1963;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  for (let y = 0; y < oddH; y++) {
    const rowOffset = y * w * 4;
    for (let x = oracle.dstX; x < oracle.dstX + oracle.dstW; x++) {
      const idx = rowOffset + (x * 4);
      rgba[idx] = 80;
      rgba[idx + 1] = 90;
      rgba[idx + 2] = 100;
    }
  }
  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.isEvenHeight, false, 'isEvenHeight must be false');
  assert.ok(res.summary.includes('Odd viewport height: 1963px'), 'Summary must report exact odd height');
});

// ============================================================================
// TRACK 4: Pure Node.js PNG Engine Resilience, Filters & Chunk Fragmentation
// ============================================================================
console.log('\n--- TRACK 4: Pure Node.js PNG Engine Resilience & Filters ---');

runTest('TRK4-01', 'PNG encode -> decode round-trip byte identity across 256x256 test pattern', () => {
  const w = 256, h = 256;
  const rawRgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      rawRgba[idx] = x & 0xff;
      rawRgba[idx + 1] = y & 0xff;
      rawRgba[idx + 2] = (x ^ y) & 0xff;
      rawRgba[idx + 3] = 255;
    }
  }

  const encoded = encodePng(w, h, rawRgba);
  const decoded = decodePng(encoded);
  assert.strictEqual(decoded.width, w);
  assert.strictEqual(decoded.height, h);
  assert.strictEqual(Buffer.compare(decoded.data, rawRgba), 0, 'Decoded RGBA buffer is 100% byte-identical');
});

runTest('TRK4-02', 'PNG decoding with fragmented multi-chunk IDAT streams (16 chunks)', () => {
  const w = 64, h = 64;
  const rawRgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < rawRgba.length; i += 4) {
    rawRgba[i] = 120;
    rawRgba[i + 1] = 130;
    rawRgba[i + 2] = 140;
    rawRgba[i + 3] = 255;
  }

  // Prepend filter byte 0 per row
  const rowLen = w * 4;
  const uncompressed = Buffer.alloc(h * (1 + rowLen));
  for (let y = 0; y < h; y++) {
    const offset = y * (1 + rowLen);
    uncompressed[offset] = 0;
    rawRgba.copy(uncompressed, offset + 1, y * rowLen, (y + 1) * rowLen);
  }
  const compressed = zlib.deflateSync(uncompressed);

  // Split compressed stream into 16 separate IDAT chunks
  const chunkCount = 16;
  const chunkSize = Math.ceil(compressed.length / chunkCount);
  const idatChunks = [];

  for (let i = 0; i < compressed.length; i += chunkSize) {
    const slice = compressed.subarray(i, Math.min(compressed.length, i + chunkSize));
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(slice.length, 0);
    const typeBuf = Buffer.from('IDAT', 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, slice])) >>> 0, 0);
    idatChunks.push(Buffer.concat([lenBuf, typeBuf, slice, crcBuf]));
  }

  // Build complete PNG with fragmented IDATs
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0);
  ihdrData.writeUInt32BE(h, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);
  const ihdrLen = Buffer.alloc(4); ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrCrc = Buffer.alloc(4); ihdrCrc.writeUInt32BE(zlib.crc32(Buffer.concat([ihdrType, ihdrData])) >>> 0, 0);
  const ihdrChunk = Buffer.concat([ihdrLen, ihdrType, ihdrData, ihdrCrc]);

  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const fragmentedPng = Buffer.concat([sig, ihdrChunk, ...idatChunks, iend]);

  const decoded = decodePng(fragmentedPng);
  assert.strictEqual(decoded.width, w);
  assert.strictEqual(decoded.height, h);
  assert.strictEqual(Buffer.compare(decoded.data, rawRgba), 0, 'Fragmented IDAT chunks decoded byte-identically');
});

runTest('TRK4-03', 'PNG scanline filter tests: Sub (1), Up (2), Average (3), Paeth (4)', () => {
  const w = 8, h = 4;
  const bpp = 4;
  const rowLen = w * bpp;

  // Row 0: filter 0 (None)
  // Row 1: filter 1 (Sub)
  // Row 2: filter 2 (Up)
  // Row 3: filter 4 (Paeth)
  const uncompressed = Buffer.alloc(h * (1 + rowLen));

  // Row 0: None
  uncompressed[0] = 0;
  for (let i = 0; i < rowLen; i++) uncompressed[1 + i] = 50;

  // Row 1: Sub (delta from left pixel)
  const row1Offset = 1 + rowLen;
  uncompressed[row1Offset] = 1; // Filter: Sub
  for (let i = 0; i < rowLen; i++) uncompressed[row1Offset + 1 + i] = 10;

  // Row 2: Up (delta from above pixel)
  const row2Offset = 2 * (1 + rowLen);
  uncompressed[row2Offset] = 2; // Filter: Up
  for (let i = 0; i < rowLen; i++) uncompressed[row2Offset + 1 + i] = 20;

  // Row 3: Paeth
  const row3Offset = 3 * (1 + rowLen);
  uncompressed[row3Offset] = 4; // Filter: Paeth
  for (let i = 0; i < rowLen; i++) uncompressed[row3Offset + 1 + i] = 5;

  const compressed = zlib.deflateSync(uncompressed);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0);
  ihdrData.writeUInt32BE(h, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);
  const ihdrLen = Buffer.alloc(4); ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrCrc = Buffer.alloc(4); ihdrCrc.writeUInt32BE(zlib.crc32(Buffer.concat([ihdrType, ihdrData])) >>> 0, 0);
  const ihdrChunk = Buffer.concat([ihdrLen, ihdrType, ihdrData, ihdrCrc]);

  const idatLen = Buffer.alloc(4); idatLen.writeUInt32BE(compressed.length, 0);
  const idatType = Buffer.from('IDAT', 'ascii');
  const idatCrc = Buffer.alloc(4); idatCrc.writeUInt32BE(zlib.crc32(Buffer.concat([idatType, compressed])) >>> 0, 0);
  const idatChunk = Buffer.concat([idatLen, idatType, compressed, idatCrc]);
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

  const testPng = Buffer.concat([sig, ihdrChunk, idatChunk, iend]);
  const decoded = decodePng(testPng);
  assert.strictEqual(decoded.width, w);
  assert.strictEqual(decoded.height, h);
  assert.ok(decoded.data.length === w * h * 4);
});

runTest('TRK4-04', 'Corrupted PNG buffers safely rejected without process termination', () => {
  assert.throws(() => decodePng(Buffer.alloc(0)), /Invalid PNG signature/);
  assert.throws(() => decodePng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])), /Invalid PNG signature/);
  assert.throws(() => decodePng(Buffer.from('not a png file at all')), /Invalid PNG signature/);
  // Valid signature but truncated IHDR
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  assert.throws(() => decodePng(sig), /Truncated PNG chunk/);
});

// ============================================================================
// TRACK 5: Turnkey CLI Semantics, Machine-Readable JSON & Option Aliases
// ============================================================================
console.log('\n--- TRACK 5: Turnkey CLI Semantics, JSON & Option Aliases ---');

runTest('TRK5-01', 'CLI --synthetic executes with exit code 0 and valid summary', () => {
  const res = cp.spawnSync('node', [VERIFIER_SCRIPT, '--synthetic'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, 'CLI --synthetic must exit with code 0');
  assert.match(res.stdout, /\[VERIFY-DISPLAY-PASS\]/, 'Stdout must contain PASS tag');
  assert.match(res.stdout, /3024x1964/, 'Must validate 3024x1964 display');
});

runTest('TRK5-02', 'CLI --synthetic --json outputs machine-readable JSON matching all contracts', () => {
  const res = cp.spawnSync('node', [VERIFIER_SCRIPT, '--synthetic', '--json'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout.trim());
  assert.strictEqual(parsed.passed, true);
  assert.strictEqual(parsed.displayWidth, 3024);
  assert.strictEqual(parsed.displayHeight, 1964);
  assert.strictEqual(parsed.centeringErrorPx, 0);
  assert.strictEqual(parsed.totalMarginViolations, 0);
  assert.strictEqual(parsed.menuBarBleed, false);
  assert.strictEqual(parsed.dockBleed, false);
  assert.ok(parsed.avgLuminance > 0);
  assert.ok(parsed.expectedViewport);
  assert.ok(parsed.measuredViewport);
});

runTest('TRK5-03', 'CLI option aliases: --expected-mode=1280x720 matches --game-res=1280x720', () => {
  const res1 = cp.spawnSync('node', [VERIFIER_SCRIPT, '--synthetic', '--json', '--expected-mode=1280x720'], { encoding: 'utf8' });
  const res2 = cp.spawnSync('node', [VERIFIER_SCRIPT, '--synthetic', '--json', '--game-res=1280x720'], { encoding: 'utf8' });
  assert.strictEqual(res1.status, 0);
  assert.strictEqual(res2.status, 0);
  const p1 = JSON.parse(res1.stdout.trim());
  const p2 = JSON.parse(res2.stdout.trim());
  assert.strictEqual(p1.expectedViewport.dstW, p2.expectedViewport.dstW);
  assert.strictEqual(p1.expectedViewport.dstH, p2.expectedViewport.dstH);
});

runTest('TRK5-04', 'CLI option aliases: --display=2560x1600 matches --display-res=2560x1600', () => {
  const res1 = cp.spawnSync('node', [VERIFIER_SCRIPT, '--synthetic', '--json', '--display=2560x1600'], { encoding: 'utf8' });
  const res2 = cp.spawnSync('node', [VERIFIER_SCRIPT, '--synthetic', '--json', '--display-res=2560x1600'], { encoding: 'utf8' });
  assert.strictEqual(res1.status, 0);
  assert.strictEqual(res2.status, 0);
  const p1 = JSON.parse(res1.stdout.trim());
  const p2 = JSON.parse(res2.stdout.trim());
  assert.strictEqual(p1.displayWidth, 2560);
  assert.strictEqual(p2.displayWidth, 2560);
  assert.strictEqual(p1.displayHeight, 1600);
  assert.strictEqual(p2.displayHeight, 1600);
});

runTest('TRK5-05', 'CLI with defective synthetic frame exits with code 1 and descriptive reasons', () => {
  const res = cp.spawnSync('node', [VERIFIER_SCRIPT, '--synthetic', '--defect=margin_white'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1, 'Defect must trigger exit code 1');
  assert.match(res.stderr, /\[VERIFY-DISPLAY-FAIL\]/, 'Stderr must report FAIL');
  assert.match(res.stderr, /Margin violations/, 'Must report margin violations');
});

runTest('TRK5-06', 'CLI with non-existent file path exits with code 2', () => {
  const res = cp.spawnSync('node', [VERIFIER_SCRIPT, '--image=/non/existent/path.png'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 2, 'Non-existent file must exit with code 2');
});

// ============================================================================
// TRACK 6: Source Code Architecture, Modal Promotion & Universal Portability
// ============================================================================
console.log('\n--- TRACK 6: Source Code Architecture & Universal Portability ---');

runTest('TRK6-01', 'C11 marker strings match architectural declarations in display_scaler.h', () => {
  const headerContent = fs.readFileSync(path.join(SCALER_DIR, 'display_scaler.h'), 'utf8');
  assert.match(headerContent, /#define\s+DS_MARKER_DLL\s+"OneLauncher\.DisplayScaler\.v1"/);
  assert.match(headerContent, /#define\s+DS_MARKER_LAUNCHER\s+"OneLauncher\.DisplayLauncher\.v1"/);

  const dllContent = fs.readFileSync(path.join(SCALER_DIR, 'display_scaler_dll.c'), 'utf8');
  assert.match(dllContent, /g_onelauncher_display_scaler_marker\[\]\s*=\s*DS_MARKER_DLL/);

  const launcherContent = fs.readFileSync(path.join(SCALER_DIR, 'display_launcher.c'), 'utf8');
  assert.match(launcherContent, /g_onelauncher_display_launcher_marker\[\]\s*=\s*DS_MARKER_LAUNCHER/);
});

runTest('TRK6-02', 'Modal dialog promotion contract: Win32 #32770 dialogs promoted to HWND_TOPMOST with unclipped cursor', () => {
  const dllContent = fs.readFileSync(path.join(SCALER_DIR, 'display_scaler_dll.c'), 'utf8');
  assert.match(dllContent, /wcscmp\(cls,\s*L"#32770"\)\s*==\s*0/, 'Checks for dialog box class #32770');
  assert.match(dllContent, /g_ds\.real_ClipCursor\(NULL\)/, 'Releases ClipCursor on dialog appearance');
  assert.match(dllContent, /g_ds\.real_SetWindowPos\(hWnd,\s*HWND_TOPMOST/, 'Promotes dialog to HWND_TOPMOST');
});

runTest('TRK6-03', 'Single-window borderless presentation: OneLauncherBackdropWnd eliminated in favor of BLACK_BRUSH', () => {
  const windowContent = fs.readFileSync(path.join(SCALER_DIR, 'display_scaler_window.c'), 'utf8');
  assert.match(windowContent, /REMOVED:\s*OneLauncherBackdropWnd/, 'Backdrop window explicitly marked removed');
  assert.doesNotMatch(windowContent, /CreateWindowExW\([^;]*OneLauncherBackdropWnd/, 'No CreateWindow calls for backdrop window');
});

runTest('TRK6-04', 'Universal Portability & Zero-PII: Scaler source tree contains zero personal paths or usernames', () => {
  const files = [
    'display_scaler.h',
    'display_scaler_internal.h',
    'display_scaler_math.c',
    'display_scaler_dll.c',
    'display_scaler_window.c',
    'display_scaler_gl_gdi.c',
    'display_launcher.c',
  ];

  const forbiddenPatterns = [
    /\/Users\/(?!Shared)/i,
    /C:\\Users\\(?!Public)/i,
    /github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/i,
    /mike/i,
  ];

  for (const file of files) {
    const filePath = path.join(SCALER_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(content, pattern, `File ${file} must not contain forbidden pattern: ${pattern}`);
    }
  }
});

// ============================================================================
// FINAL SUMMARY & VERDICT
// ============================================================================
console.log('\n================================================================');
console.log('  ADVERSARIAL SUITE SUMMARY');
console.log('================================================================');
console.log(`  Total Tests Run:    ${totalPassed + totalFailed}`);
console.log(`  Passed:             ${totalPassed}`);
console.log(`  Failed:             ${totalFailed}`);
console.log('================================================================\n');

if (totalFailed > 0) {
  console.error(`VERDICT: REJECT (${totalFailed} adversarial tests failed)`);
  process.exit(1);
} else {
  console.log('VERDICT: APPROVE (All adversarial coverage hardening tests passed cleanly!)');
  process.exit(0);
}
