'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert');
const os = require('node:os');

const {
  encodePng,
  decodePng,
  verifyDisplayOutput,
  analyzeDisplayPixels,
  computeOracleViewport,
  generateSyntheticDisplayBuffer,
} = require('../scripts/verify-display-output.cjs');

console.log('================================================================');
console.log('  CHALLENGER 3 ADVERSARIAL STRESS & INVARIANT VERIFICATION');
console.log('  Target: scripts/verify-display-output.cjs (Iteration 2 Fixes)');
console.log('================================================================\n');

const cliPath = path.resolve(__dirname, '../scripts/verify-display-output.cjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger3-verify-'));

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

// -----------------------------------------------------------------------------
// SECTION 1: ADVERSARIAL ODD VIEWPORT HEIGHT REJECTION
// -----------------------------------------------------------------------------
console.log('\n--- Section 1: Adversarial Odd Viewport Height Rejection ---');

// 1.1 In-process odd height 1963px on 3024x1964 display
recordTest('ODD-01', 'Programmatic rejection of odd viewport height dstH=1963 in 3024x1964', () => {
  const w = 3024;
  const h = 1964;
  const oracle = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
  const oddH = 1963;

  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  for (let y = 0; y < oddH; y++) {
    const rowOffset = y * w * 4;
    for (let x = oracle.dstX; x < oracle.dstX + oracle.dstW; x++) {
      const idx = rowOffset + (x * 4);
      rgba[idx] = 100;
      rgba[idx + 1] = 120;
      rgba[idx + 2] = 140;
    }
  }

  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h });

  assert.strictEqual(res.passed, false, 'passed must be false');
  assert.strictEqual(res.isEvenHeight, false, 'isEvenHeight must be false');
  assert.strictEqual(res.exitCode, 1, 'exitCode must be 1');
  assert.ok(res.summary.includes('Odd viewport height: 1963px'), 'Summary must report exact odd height');
  return `Passed=${res.passed}, isEvenHeight=${res.isEvenHeight}, summary=${res.summary}`;
});

// 1.2 CLI execution with --image pointing to odd height PNG: exit code 1
recordTest('ODD-02', 'CLI execution with --image of odd viewport height returns exit code 1', () => {
  const w = 3024;
  const h = 1964;
  const oracle = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
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

  const pngPath = path.join(tempDir, 'odd_viewport_1963.png');
  fs.writeFileSync(pngPath, encodePng(w, h, rgba));

  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  try {
    cp.execSync(`node "${cliPath}" --image="${pngPath}" --display-res=3024x1964`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    exitCode = err.status;
    stdout = err.stdout ? err.stdout.toString() : '';
    stderr = err.stderr ? err.stderr.toString() : '';
  }

  assert.strictEqual(exitCode, 1, `Expected exit code 1, got ${exitCode}`);
  assert.ok(stderr.includes('[VERIFY-DISPLAY-FAIL]'), 'Stderr must contain [VERIFY-DISPLAY-FAIL]');
  assert.ok(stderr.includes('Odd viewport height: 1963px'), 'Stderr must identify odd viewport height');
  return `Exit code: ${exitCode}, Stderr: ${stderr.trim()}`;
});

// 1.3 CLI execution with --image and --json: valid JSON with passed: false and exit code 1
recordTest('ODD-03', 'CLI execution with --image and --json produces passed:false with exit code 1', () => {
  const pngPath = path.join(tempDir, 'odd_viewport_1963.png');
  let exitCode = 0;
  let stdout = '';
  try {
    stdout = cp.execSync(`node "${cliPath}" --image="${pngPath}" --display-res=3024x1964 --json`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    exitCode = err.status;
    stdout = err.stdout ? err.stdout.toString() : '';
  }

  assert.strictEqual(exitCode, 1, `Expected exit code 1, got ${exitCode}`);
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.passed, false, 'JSON passed must be false');
  assert.strictEqual(parsed.isEvenHeight, false, 'JSON isEvenHeight must be false');
  assert.strictEqual(parsed.measuredViewport.dstH, 1963, 'JSON dstH must be 1963');
  return `JSON passed=${parsed.passed}, isEvenHeight=${parsed.isEvenHeight}, exitCode=${exitCode}`;
});

// 1.4 Odd viewport height boundary: Math.abs(margin_top - margin_bottom) <= 1 would pass symmetry without isEvenHeight
recordTest('ODD-04', 'Even-height check detects odd viewport even when margin asymmetry is <= 1px', () => {
  const w = 3024;
  const h = 1964;
  const oracle = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
  // dstY = 0, dstH = 1963 -> topMargin = 0, bottomMargin = 1964 - 1963 = 1.
  // |topMargin - bottomMargin| = 1 <= 1, so symmetricVerticalMargins IS TRUE!
  const oddH = 1963;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  for (let y = 0; y < oddH; y++) {
    const rowOffset = y * w * 4;
    for (let x = oracle.dstX; x < oracle.dstX + oracle.dstW; x++) {
      const idx = rowOffset + (x * 4);
      rgba[idx] = 111;
      rgba[idx + 1] = 122;
      rgba[idx + 2] = 133;
    }
  }

  const png = encodePng(w, h, rgba);
  const analysis = analyzeDisplayPixels(decodePng(png), oracle, w, h);

  assert.strictEqual(analysis.symmetricMargins, true, 'Symmetric margins is true because 1px diff is within tolerance');
  assert.strictEqual(analysis.isEvenHeight, false, 'isEvenHeight must catch the odd height');
  assert.strictEqual(analysis.passed, false, 'isEvenHeight must cause overall verification failure');
  assert.ok(analysis.summary.includes('Odd viewport height: 1963px'));
  return `symmetricMargins=${analysis.symmetricMargins}, isEvenHeight=${analysis.isEvenHeight}, passed=${analysis.passed}`;
});

// 1.5 Letterbox odd height (e.g. 1079px in 1920x1080 display)
recordTest('ODD-05', 'Rejection of odd letterbox height 1079px in 1920x1080 display', () => {
  const w = 1920;
  const h = 1080;
  const oracle = computeOracleViewport(w, h, 0, 1920, 1080, 'preserve');
  const oddH = 1079;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  for (let y = 0; y < oddH; y++) {
    const rowOffset = y * w * 4;
    for (let x = 0; x < w; x++) {
      const idx = rowOffset + (x * 4);
      rgba[idx] = 90;
      rgba[idx + 1] = 90;
      rgba[idx + 2] = 90;
    }
  }

  const png = encodePng(w, h, rgba);
  const res = verifyDisplayOutput({ imageBuffer: png, displayWidth: w, displayHeight: h, virtW: 1920, virtH: 1080 });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.isEvenHeight, false);
  assert.ok(res.summary.includes('Odd viewport height: 1079px'));
  return `passed=${res.passed}, summary=${res.summary}`;
});

// -----------------------------------------------------------------------------
// SECTION 2: ADVERSARIAL CLI ALIASES & CONFIGURATION APPLICATION
// -----------------------------------------------------------------------------
console.log('\n--- Section 2: Adversarial CLI Option Aliases ---');

// 2.1 --expected-mode=1280x720 applies exact 1280x720 virtual mode
recordTest('ALIAS-01', 'CLI --expected-mode=1280x720 correctly configures 1280x720 virtual resolution', () => {
  const out = cp.execSync(`node "${cliPath}" --synthetic --expected-mode=1280x720 --json`, { encoding: 'utf8' });
  const parsed = JSON.parse(out);

  assert.strictEqual(parsed.passed, true);
  assert.strictEqual(parsed.expectedViewport.dstW, 3024);
  assert.strictEqual(parsed.expectedViewport.dstH, 1700);
  assert.strictEqual(parsed.expectedViewport.dstX, 0);
  assert.strictEqual(parsed.expectedViewport.dstY, 132);
  assert.strictEqual(parsed.measuredViewport.dstW, 3024);
  assert.strictEqual(parsed.measuredViewport.dstH, 1700);
  assert.strictEqual(parsed.measuredViewport.dstY, 132);
  return `Configured expectedViewport: [${parsed.expectedViewport.dstX}, ${parsed.expectedViewport.dstY}, ${parsed.expectedViewport.dstW}x${parsed.expectedViewport.dstH}]`;
});

// 2.2 CLI --expected-mode vs --game-res parity check
recordTest('ALIAS-02', 'Parity between --expected-mode=1280x720 and --game-res=1280x720', () => {
  const out1 = cp.execSync(`node "${cliPath}" --synthetic --expected-mode=1280x720 --json`, { encoding: 'utf8' });
  const out2 = cp.execSync(`node "${cliPath}" --synthetic --game-res=1280x720 --json`, { encoding: 'utf8' });
  const parsed1 = JSON.parse(out1);
  const parsed2 = JSON.parse(out2);

  assert.deepStrictEqual(parsed1.expectedViewport, parsed2.expectedViewport);
  assert.deepStrictEqual(parsed1.measuredViewport, parsed2.measuredViewport);
  assert.strictEqual(parsed1.passed, parsed2.passed);
  return 'Identical output between --expected-mode and --game-res';
});

// 2.3 CLI --display=2560x1600 applies exact 2560x1600 panel dimensions
recordTest('ALIAS-03', 'CLI --display=2560x1600 correctly configures display dimensions', () => {
  const out = cp.execSync(`node "${cliPath}" --synthetic --display=2560x1600 --json`, { encoding: 'utf8' });
  const parsed = JSON.parse(out);

  assert.strictEqual(parsed.passed, true);
  assert.strictEqual(parsed.displayWidth, 2560);
  assert.strictEqual(parsed.displayHeight, 1600);
  assert.strictEqual(parsed.expectedViewport.dstW, 2134);
  assert.strictEqual(parsed.expectedViewport.dstH, 1600);
  assert.strictEqual(parsed.expectedViewport.dstX, 213);
  assert.strictEqual(parsed.expectedViewport.dstY, 0);
  return `Panel: ${parsed.displayWidth}x${parsed.displayHeight}, Viewport: [${parsed.expectedViewport.dstX}, ${parsed.expectedViewport.dstY}, ${parsed.expectedViewport.dstW}x${parsed.expectedViewport.dstH}]`;
});

// 2.4 CLI --display vs --display-res parity check
recordTest('ALIAS-04', 'Parity between --display=2560x1600 and --display-res=2560x1600', () => {
  const out1 = cp.execSync(`node "${cliPath}" --synthetic --display=2560x1600 --json`, { encoding: 'utf8' });
  const out2 = cp.execSync(`node "${cliPath}" --synthetic --display-res=2560x1600 --json`, { encoding: 'utf8' });
  const parsed1 = JSON.parse(out1);
  const parsed2 = JSON.parse(out2);

  assert.strictEqual(parsed1.displayWidth, parsed2.displayWidth);
  assert.strictEqual(parsed1.displayHeight, parsed2.displayHeight);
  assert.deepStrictEqual(parsed1.expectedViewport, parsed2.expectedViewport);
  return 'Identical output between --display and --display-res';
});

// 2.5 Combined --display=2560x1600 AND --expected-mode=1280x720
recordTest('ALIAS-05', 'CLI combining --display=2560x1600 and --expected-mode=1280x720', () => {
  const out = cp.execSync(`node "${cliPath}" --synthetic --display=2560x1600 --expected-mode=1280x720 --json`, { encoding: 'utf8' });
  const parsed = JSON.parse(out);

  assert.strictEqual(parsed.passed, true);
  assert.strictEqual(parsed.displayWidth, 2560);
  assert.strictEqual(parsed.displayHeight, 1600);
  // In 2560x1600 (16:10), 1280x720 (16:9) letterboxes: dstW=2560, dstH=1440, dstX=0, dstY=80
  assert.strictEqual(parsed.expectedViewport.dstW, 2560);
  assert.strictEqual(parsed.expectedViewport.dstH, 1440);
  assert.strictEqual(parsed.expectedViewport.dstX, 0);
  assert.strictEqual(parsed.expectedViewport.dstY, 80);
  return `Combined viewport verified: [${parsed.expectedViewport.dstX}, ${parsed.expectedViewport.dstY}, ${parsed.expectedViewport.dstW}x${parsed.expectedViewport.dstH}]`;
});

// 2.6 CLI --capture alias flag execution
recordTest('ALIAS-06', 'CLI --capture alias triggers capture path correctly', () => {
  // Check if --capture flag executes. In locked CI / test environment, it gracefully detects lock state.
  // In an unlocked live session (e.g. current desktop), screencapture runs and analyzes real screen pixels.
  let code = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = cp.execSync(`node "${cliPath}" --capture --json`, { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    code = err.status;
    stdout = err.stdout ? err.stdout.toString() : '';
    stderr = err.stderr ? err.stderr.toString() : '';
  }

  // Parse stdout if JSON was printed
  if (stdout.trim().startsWith('{')) {
    const parsed = JSON.parse(stdout);
    // It should either skip due to screen lock (skipped: true) or execute real display analysis
    assert.ok(parsed.skipped === true || (parsed.displayWidth > 0 && parsed.measuredViewport !== undefined),
      'CLI --capture must yield skipped:true or valid display analysis metrics');
    return `Output: passed=${parsed.passed}, skipped=${parsed.skipped}, panel=${parsed.displayWidth}x${parsed.displayHeight}`;
  } else {
    // If not JSON, verify stdout / stderr
    assert.ok(stdout.includes('[VERIFY-DISPLAY') || stderr.includes('[VERIFY-DISPLAY'), 'CLI --capture executed');
    return `Output: ${stdout.trim() || stderr.trim()}`;
  }
});

// 2.7 Programmatic option aliases: expectedMode, gameRes, display, displayRes
recordTest('ALIAS-07', 'Programmatic option aliases in verifyDisplayOutput()', () => {
  // Test expectedMode and display
  const res1 = verifyDisplayOutput({
    synthetic: true,
    expectedMode: '1280x720',
    display: '2560x1600',
  });
  assert.strictEqual(res1.passed, true);
  assert.strictEqual(res1.displayWidth, 2560);
  assert.strictEqual(res1.displayHeight, 1600);
  assert.strictEqual(res1.expectedViewport.dstW, 2560);
  assert.strictEqual(res1.expectedViewport.dstH, 1440);

  // Test gameRes and displayRes
  const res2 = verifyDisplayOutput({
    synthetic: true,
    gameRes: '1280x720',
    displayRes: '2560x1600',
  });
  assert.deepStrictEqual(res1.expectedViewport, res2.expectedViewport);
  return 'Programmatic aliases match CLI parsing';
});

// 2.8 Resilient fallback on malformed alias values
recordTest('ALIAS-08', 'Graceful fallback on malformed --expected-mode and --display values', () => {
  const out = cp.execSync(`node "${cliPath}" --synthetic --expected-mode=invalid --display=corrupt --json`, { encoding: 'utf8' });
  const parsed = JSON.parse(out);

  // Malformed input should not crash, but fall back to default geometry (3024x1964, 640x480)
  assert.strictEqual(parsed.passed, true);
  assert.strictEqual(parsed.displayWidth, 3024);
  assert.strictEqual(parsed.displayHeight, 1964);
  assert.strictEqual(parsed.expectedViewport.dstW, 2620);
  assert.strictEqual(parsed.expectedViewport.dstH, 1964);
  return 'Malformed values gracefully fell back to default geometries';
});

// Clean up temp dir
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // ignore
}

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('  CHALLENGER 3 SUMMARY');
console.log('================================================================');
const total = results.length;
const passedCount = results.filter(r => r.passed).length;
const failedCount = results.filter(r => !r.passed).length;
console.log(`Total: ${total} | Passed: ${passedCount} | Failed: ${failedCount}\n`);

if (failedCount > 0) {
  for (const r of results) {
    if (!r.passed) {
      console.log(`FAILED: [${r.id}] ${r.name}`);
      console.log(`  Reason: ${r.error}\n`);
    }
  }
  process.exit(1);
} else {
  console.log('ALL ADVERSARIAL CHALLENGER TESTS PASSED EMPIRICALLY!\n');
}
