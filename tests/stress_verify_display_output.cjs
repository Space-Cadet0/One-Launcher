'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert');

const {
  encodePng,
  decodePng,
  verifyDisplayOutput,
  analyzeDisplayPixels,
  computeOracleViewport,
  generateSyntheticDisplayBuffer,
} = require('../scripts/verify-display-output.cjs');

console.log('====================================================');
console.log('  CHALLENGER 1 ADVERSARIAL STRESS TEST HARNESS');
console.log('  Target: scripts/verify-display-output.cjs');
console.log('====================================================\n');

const results = [];

function recordTest(id, name, runFn) {
  try {
    const outcome = runFn();
    results.push({ id, name, passed: true, outcome });
    console.log(`  ✓ [PASS] [${id}] ${name}`);
  } catch (err) {
    results.push({ id, name, passed: false, error: err.message, stack: err.stack });
    console.log(`  ✗ [FAIL] [${id}] ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

// Helper to create clean 3024x1964 frame buffer with centered 2620x1964 content (4:3 in Retina)
function createCleanRetinaBuffer(w = 3024, h = 1964, virtW = 640, virtH = 480) {
  const oracle = computeOracleViewport(w, h, 0, virtW, virtH, 'preserve');
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; // full alpha

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

// -----------------------------------------------------------------------------
// SECTION 1: VISUAL DEFECT DETECTION
// -----------------------------------------------------------------------------
console.log('\n--- Section 1: Visual Defect Detection ---');

// 1.1 Non-black pillarboxes: White (#ECECEC = 236, 236, 236)
recordTest('DEFECT-01', 'Detection of white #ECECEC pillarbox pollution', () => {
  const { rgba, w, h } = createCleanRetinaBuffer();
  // Inject #ECECEC in left pillarbox at x=50, y=500
  const idx = (500 * w + 50) * 4;
  rgba[idx] = 0xEC;
  rgba[idx + 1] = 0xEC;
  rgba[idx + 2] = 0xEC;

  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false, 'Expected failure due to white pillarbox pixel');
  assert.ok(res.totalMarginViolations >= 1, 'Expected margin violations');
  assert.ok(res.summary.includes('Margin violations'), 'Summary must mention margin violations');
  return `Violations: ${res.totalMarginViolations}, summary: ${res.summary}`;
});

// 1.2 Non-black pillarboxes: Subtle RGB(1, 0, 0)
recordTest('DEFECT-02', 'Detection of subtle RGB(1, 0, 0) pillarbox pollution', () => {
  const { rgba, w, h } = createCleanRetinaBuffer();
  // Inject subtle 1-bit red pixel in right pillarbox (x=2900, y=1000)
  const idx = (1000 * w + 2900) * 4;
  rgba[idx] = 1;
  rgba[idx + 1] = 0;
  rgba[idx + 2] = 0;

  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false, 'Expected failure due to RGB(1,0,0) pixel');
  assert.ok(res.totalMarginViolations >= 1, 'Expected margin violations');
  assert.ok(res.summary.includes('Margin violations'), 'Summary must mention margin violations');
  return `Violations: ${res.totalMarginViolations}, summary: ${res.summary}`;
});

// 1.3 Menu Bar Bleed: Non-zero pixels in top 44px
recordTest('DEFECT-03', 'Detection of Menu Bar bleed in top 44px (e.g. y=20, pillarbox margin)', () => {
  const { rgba, w, h } = createCleanRetinaBuffer();
  // In pillarbox margin (x=50, y=20)
  const idx = (20 * w + 50) * 4;
  rgba[idx] = 200;
  rgba[idx + 1] = 200;
  rgba[idx + 2] = 200;

  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false, 'Expected failure due to menu bar bleed');
  assert.strictEqual(res.menuBarBleed, true, 'menuBarBleed flag must be true');
  assert.ok(res.summary.includes('Menu Bar bleed'), 'Summary must mention Menu Bar bleed');
  return `menuBarBleed=${res.menuBarBleed}, summary: ${res.summary}`;
});

// 1.4 Dock Bleed: Non-zero pixels in bottom 40px (e.g. y=height - 25, pillarbox margin)
recordTest('DEFECT-04', 'Detection of Dock bleed in bottom 40px (e.g. y=1940, pillarbox margin)', () => {
  const { rgba, w, h } = createCleanRetinaBuffer();
  // In pillarbox margin (x=50, y=1940)
  const idx = (1940 * w + 50) * 4;
  rgba[idx] = 180;
  rgba[idx + 1] = 180;
  rgba[idx + 2] = 180;

  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false, 'Expected failure due to dock bleed');
  assert.strictEqual(res.dockBleed, true, 'dockBleed flag must be true');
  assert.ok(res.summary.includes('Dock bleed'), 'Summary must mention Dock bleed');
  return `dockBleed=${res.dockBleed}, summary: ${res.summary}`;
});

// 1.5 Asymmetric Horizontal Margins: Centering error > 1px
recordTest('DEFECT-05', 'Detection of asymmetric horizontal margins (centering error > 1px, e.g. dstX shifted by +4px)', () => {
  const w = 3024;
  const h = 1964;
  const oracle = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
  const shiftedDstX = oracle.dstX + 4; // Shifted right by 4px
  const shiftedDstW = oracle.dstW;

  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

  for (let y = oracle.dstY; y < oracle.dstY + oracle.dstH; y++) {
    const rowOffset = y * w * 4;
    for (let x = shiftedDstX; x < shiftedDstX + shiftedDstW; x++) {
      const idx = rowOffset + (x * 4);
      rgba[idx] = 40 + ((x * 7) % 180);
      rgba[idx + 1] = 50 + ((y * 11) % 180);
      rgba[idx + 2] = 130;
    }
  }

  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });
  assert.strictEqual(res.passed, false, 'Expected failure due to asymmetric margins');
  assert.ok(res.centeringErrorPx >= 4 || res.horizontalCenteringError >= 4, 'Centering error must be reported >= 4px');
  assert.ok(res.summary.includes('Centering offset') || res.summary.includes('Asymmetric horizontal margins'), 'Summary must note centering/asymmetry');
  return `centeringError=${res.centeringErrorPx}, summary: ${res.summary}`;
});

// 1.6 Odd Viewport Height: Height is 1963 (odd) in 3024x1964
recordTest('DEFECT-06', 'Detection of odd viewport height (dstH = 1963)', () => {
  const w = 3024;
  const h = 1964;
  const oracle = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
  // Oracle dstH is 1964. Suppose game renders odd height 1963 (dstY: 0, dstH: 1963)
  const oddDstH = 1963;

  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

  for (let y = 0; y < oddDstH; y++) {
    const rowOffset = y * w * 4;
    for (let x = oracle.dstX; x < oracle.dstX + oracle.dstW; x++) {
      const idx = rowOffset + (x * 4);
      rgba[idx] = 40 + ((x * 7) % 180);
      rgba[idx + 1] = 50 + ((y * 11) % 180);
      rgba[idx + 2] = 130;
    }
  }

  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });

  // CHECK: Did the verification tool detect and fail odd viewport height?
  assert.strictEqual(res.isEvenHeight, false, 'isEvenHeight must be false');
  // The mission says: "Odd viewport height -> confirm failure is detected."
  assert.strictEqual(res.passed, false, 'CRITICAL CHECK: Odd viewport height must cause verification failure');
  return `passed=${res.passed}, isEvenHeight=${res.isEvenHeight}, summary: ${res.summary}`;
});

// -----------------------------------------------------------------------------
// SECTION 2: MALFORMED AND TRUNCATED PNG FILES
// -----------------------------------------------------------------------------
console.log('\n--- Section 2: Malformed and Truncated PNG Files ---');

// 2.1 Truncated PNG header
recordTest('PNG-01', 'Graceful handling of truncated PNG buffer (3 bytes)', () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e]);
  const res = verifyDisplayOutput({ imageBuffer: buf });
  assert.strictEqual(res.passed, false, 'Must not pass');
  assert.strictEqual(res.ok, false, 'ok must be false');
  assert.strictEqual(res.exitCode, 2, 'exitCode must be 2 for decode error');
  assert.ok(res.error.includes('signature') || res.error.includes('PNG'), 'Error message must explain issue');
  return `res.error: ${res.error}`;
});

// 2.2 Truncated at IHDR
recordTest('PNG-02', 'Graceful handling of truncated IHDR chunk', () => {
  // Valid signature + incomplete IHDR
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48]);
  const res = verifyDisplayOutput({ imageBuffer: buf });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.exitCode, 2);
  return `res.error: ${res.error}`;
});

// 2.3 Corrupted IDAT zlib payload
recordTest('PNG-03', 'Graceful handling of corrupted IDAT zlib stream', () => {
  const { rgba, w, h } = createCleanRetinaBuffer(320, 240, 320, 240);
  const validPng = encodePng(320, 240, rgba);
  // Find IDAT chunk
  const idatOffset = validPng.indexOf(Buffer.from('IDAT'));
  assert.ok(idatOffset > 0, 'Must find IDAT chunk');
  const corruptedPng = Buffer.from(validPng);
  // Corrupt 20 bytes inside IDAT payload
  for (let i = 0; i < 20; i++) {
    corruptedPng[idatOffset + 8 + i] ^= 0xFF;
  }
  const res = verifyDisplayOutput({ imageBuffer: corruptedPng, displayWidth: 320, displayHeight: 240 });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.exitCode, 2);
  assert.ok(res.error, 'Must have error');
  return `res.error: ${res.error}`;
});

// 2.4 Empty buffer
recordTest('PNG-04', 'Graceful handling of empty buffer', () => {
  const buf = Buffer.alloc(0);
  const res = verifyDisplayOutput({ imageBuffer: buf });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.exitCode, 2);
  return `res.error: ${res.error}`;
});

// 2.5 Non-existent image path
recordTest('PNG-05', 'Graceful handling of non-existent file path', () => {
  const res = verifyDisplayOutput({ image: '/nonexistent/path/to/test.png' });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.exitCode, 2);
  assert.ok(res.error.includes('does not exist') || res.error.includes('ENOENT'));
  return `res.error: ${res.error}`;
});

// -----------------------------------------------------------------------------
// SECTION 3: CLI INVOCATION TESTING
// -----------------------------------------------------------------------------
console.log('\n--- Section 3: CLI Invocation Testing ---');

const cliPath = path.resolve(__dirname, '../scripts/verify-display-output.cjs');

// 3.1 CLI --synthetic
recordTest('CLI-01', 'CLI invocation with --synthetic', () => {
  const out = cp.execSync(`node "${cliPath}" --synthetic`, { encoding: 'utf8' });
  assert.ok(out.includes('[VERIFY-DISPLAY-PASS]'), 'Must output PASS');
  assert.ok(out.includes('PASS: Validated 3024x1964 display output'), 'Must validate default 3024x1964');
  return out.trim();
});

// 3.2 CLI --synthetic --json
recordTest('CLI-02', 'CLI invocation with --synthetic --json', () => {
  const out = cp.execSync(`node "${cliPath}" --synthetic --json`, { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.passed, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.displayWidth, 3024);
  assert.strictEqual(parsed.displayHeight, 1964);
  return `JSON passed: ${parsed.passed}, dims: ${parsed.displayWidth}x${parsed.displayHeight}`;
});

// 3.3 CLI --synthetic --verbose
recordTest('CLI-03', 'CLI invocation with --synthetic --verbose', () => {
  const out = cp.execSync(`node "${cliPath}" --synthetic --verbose`, { encoding: 'utf8' });
  assert.ok(out.includes('Panel: 3024x1964'), 'Must output Panel line');
  assert.ok(out.includes('Expected Viewport:'), 'Must output Expected Viewport');
  assert.ok(out.includes('Measured Viewport:'), 'Must output Measured Viewport');
  assert.ok(out.includes('Centering Error: 0px'), 'Must output Centering Error');
  return 'Verbose output formatted correctly';
});

// 3.4 CLI --expected-mode=<w>x<h>
recordTest('CLI-04', 'CLI invocation with --expected-mode=1280x720', () => {
  const out = cp.execSync(`node "${cliPath}" --synthetic --expected-mode=1280x720 --json`, { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  // Expected for 1280x720 in 3024x1964 letterbox: dstW = 3024, dstH = 1700, dstX = 0, dstY = 132
  assert.strictEqual(parsed.expectedViewport.dstW, 3024, `Expected dstW 3024, got ${parsed.expectedViewport.dstW}`);
  assert.strictEqual(parsed.expectedViewport.dstH, 1700, `Expected dstH 1700, got ${parsed.expectedViewport.dstH}`);
  return `dstW: ${parsed.expectedViewport.dstW}, dstH: ${parsed.expectedViewport.dstH}`;
});

// 3.5 CLI --display=<w>x<h>
recordTest('CLI-05', 'CLI invocation with --display=2560x1600', () => {
  const out = cp.execSync(`node "${cliPath}" --synthetic --display=2560x1600 --json`, { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.displayWidth, 2560, `Expected displayWidth 2560, got ${parsed.displayWidth}`);
  assert.strictEqual(parsed.displayHeight, 1600, `Expected displayHeight 1600, got ${parsed.displayHeight}`);
  return `displayWidth: ${parsed.displayWidth}, displayHeight: ${parsed.displayHeight}`;
});

// 3.6 CLI --capture
recordTest('CLI-06', 'CLI invocation with --capture', () => {
  // Test running --capture with --help or checking option parsing
  // We want to verify whether --capture is accepted as an option alias for live capture
  // When run with --capture on locked screen or in headless, it should handle gracefully
  let code = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = cp.execSync(`node "${cliPath}" --capture --help`, { encoding: 'utf8' });
  } catch (err) {
    code = err.status;
    stdout = err.stdout;
    stderr = err.stderr;
  }
  // Check usage text for --capture
  assert.ok(stdout.includes('--capture') || stdout.includes('--live'), 'CLI usage must list capture option');
  return 'Checked CLI --capture handling';
});

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------
console.log('\n====================================================');
console.log('  TEST SUMMARY');
console.log('====================================================');
const total = results.length;
const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}\n`);

for (const r of results) {
  if (!r.passed) {
    console.log(`FAILED: [${r.id}] ${r.name}`);
    console.log(`  Reason: ${r.error}\n`);
  }
}
