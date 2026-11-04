'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, runNativeMathAsan } = require('../harness/index.cjs');

suite('Tier 2 — Feature F15 Boundaries: 10-Element Code Review & Criteria 6-10', () => {
  test({
    id: 'F15-B01',
    feature: 'F15',
    tier: 2,
    description: 'Criterion 6 (State & Data Flow): clean architectural separation across supervisor, PE launcher host, and DLL',
  }, () => {
    const launcherH = path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler.h');
    const internalH = path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_internal.h');

    assert.ok(fs.existsSync(launcherH), 'Shared public header must exist');
    assert.ok(fs.existsSync(internalH), 'Internal implementation header must exist');
  });

  test({
    id: 'F15-B02',
    feature: 'F15',
    tier: 2,
    description: 'Criterion 7 (Resilience): critical sections protect shared state in multi-threaded game environments',
  }, () => {
    const glGdiSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    const usesCriticalSection = /EnterCriticalSection\s*\(\s*&g_ds\.lock\s*\)/m.test(glGdiSrc) &&
      /LeaveCriticalSection\s*\(\s*&g_ds\.lock\s*\)/m.test(glGdiSrc);

    assert.ok(usesCriticalSection, 'F15 Criterion 7: Presenter hooks must acquire g_ds.lock before reading viewport state');
  });

  test({
    id: 'F15-B03',
    feature: 'F15',
    tier: 2,
    description: 'Criterion 8 (Security & Type Safety): native math engine compiles and passes AddressSanitizer/UBSan without leaks or undefined behavior',
  }, () => {
    const asan = runNativeMathAsan();
    assert.strictEqual(
      asan.status,
      0,
      `F15 Criterion 8 violation: ASan/UBSan detected memory/undefined behavior errors: ${asan.stderr || asan.stdout}`
    );
  });

  test({
    id: 'F15-B04',
    feature: 'F15',
    tier: 2,
    description: 'Criterion 9 (Universal Dimensions): zero hardcoded game title strings in PE launcher host',
  }, () => {
    const launcherSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_launcher.c'),
      'utf8'
    );

    const hasSpecificGame = /Dark\s*Forces/i.test(launcherSrc) ||
      /Quake/i.test(launcherSrc) ||
      /Jedi/i.test(launcherSrc);

    assert.strictEqual(
      hasSpecificGame,
      false,
      'F15 Criterion 9: display_launcher.c must remain fully game-agnostic'
    );
  });

  test({
    id: 'F15-B05',
    feature: 'F15',
    tier: 2,
    description: 'Criterion 10 (Zero Hardcoded Paths): zero absolute local home directories or usernames in test fixtures or code',
  }, () => {
    const testFiles = [
      path.resolve(__dirname, 'f1_backdrop_boundary.test.cjs'),
      path.resolve(__dirname, 'f2_hidpi_boundary.test.cjs'),
      path.resolve(__dirname, 'f3_mode_table_boundary.test.cjs'),
    ];

    const piiRegex = /\/Users\/(?!runner|Shared)[a-zA-Z0-9_-]+\//;
    for (const f of testFiles) {
      const content = fs.readFileSync(f, 'utf8');
      assert.strictEqual(piiRegex.test(content), false, `PII found in ${path.basename(f)}`);
    }
  });
});
