#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run, defaultRunner } = require('./harness/index.cjs');

// Parse CLI options
const args = process.argv.slice(2);
let tierFilter = null;
let featureFilter = null;
let grepFilter = null;
let jsonOutPath = null;
let bail = false;
let verifyOnly = false;

for (const arg of args) {
  if (arg.startsWith('--tier=')) {
    tierFilter = parseInt(arg.slice(7), 10);
  } else if (arg.startsWith('--feature=')) {
    featureFilter = arg.slice(10);
  } else if (arg.startsWith('--grep=')) {
    grepFilter = arg.slice(7);
  } else if (arg.startsWith('--json=')) {
    jsonOutPath = path.resolve(process.cwd(), arg.slice(7));
  } else if (arg === '--bail') {
    bail = true;
  } else if (arg === '--verify') {
    verifyOnly = true;
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
One Launcher Universal Fullscreen & HiDPI E2E Test Suite Runner

Usage:
  node tests/e2e_fullscreen/run_all.cjs [options]

Options:
  --tier=<1|2|3|4>     Run tests only for the specified tier
  --feature=<F1..F15>  Run tests matching the specific feature ID
  --grep=<pattern>     Filter tests by substring in ID or description
  --json=<file>        Write detailed test execution report to JSON file
  --bail               Abort immediately on first test failure
  --verify             Verify test suite loading and registration without executing
  -h, --help           Show this help message
`);
    process.exit(0);
  }
}

// Collect and load all test files
const suitesDir = __dirname;
const testSubdirs = [
  'tier1_features',
  'tier2_boundaries',
  'tier3_combinations',
  'tier4_scenarios',
];

const loadedFiles = [];

for (const subdir of testSubdirs) {
  const dirPath = path.join(suitesDir, subdir);
  if (!fs.existsSync(dirPath)) continue;

  const files = fs.readdirSync(dirPath)
    .filter(f => f.endsWith('.test.cjs'))
    .sort();

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    try {
      require(fullPath);
      loadedFiles.push(path.relative(suitesDir, fullPath));
    } catch (err) {
      console.error(`\x1b[31mFailed to load test file ${fullPath}:\x1b[0m`, err);
      process.exit(2);
    }
  }
}

// Calculate registered tests
let totalRegisteredTests = 0;
const tierCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
for (const s of defaultRunner.suites) {
  for (const t of s.tests) {
    totalRegisteredTests += 1;
    if (tierCounts[t.tier] !== undefined) {
      tierCounts[t.tier] += 1;
    }
  }
}

if (verifyOnly) {
  console.log('\n[E2E-VERIFY] Test Suite Verification Successful:');
  console.log(`  Loaded test files: ${loadedFiles.length}`);
  console.log(`  Total registered tests: ${totalRegisteredTests}`);
  console.log(`    Tier 1 (Feature Coverage):     ${tierCounts[1]}`);
  console.log(`    Tier 2 (Boundary & Corners):   ${tierCounts[2]}`);
  console.log(`    Tier 3 (Cross-Combinations):   ${tierCounts[3]}`);
  console.log(`    Tier 4 (Real-World Scenarios): ${tierCounts[4]}`);
  process.exit(0);
}

// Execute the test suite
async function main() {
  try {
    const results = await run({
      tierFilter,
      featureFilter,
      grepFilter,
      bail,
    });

    if (jsonOutPath) {
      fs.writeFileSync(jsonOutPath, JSON.stringify(results, null, 2), 'utf8');
      console.log(`[E2E] Detailed JSON test report written to: ${jsonOutPath}`);
    }

    if (results.failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error('\x1b[31mFatal test runner error:\x1b[0m', err);
    process.exit(2);
  }
}

main();
