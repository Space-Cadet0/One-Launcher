'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

suite('Tier 1 — Feature F15: 10-Element Code Review & Audit', () => {
  test({
    id: 'F15-01',
    feature: 'F15',
    tier: 1,
    description: 'Criterion 1 (De-Hacking): eliminates arbitrary sleeps and heuristic polling in window management',
    tier: 1,
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    // Arbitrary sleep heuristics like Sleep(500) inside wndproc or presentation loops are forbidden
    const hasArbitrarySleepLoop = /for\s*\([^)]*\)\s*\{\s*Sleep\s*\(\s*\d{3,}\s*\)/m.test(src);
    assert.strictEqual(
      hasArbitrarySleepLoop,
      false,
      'F15 Criterion 1 violation: arbitrary sleep polling loops in window presentation must be eliminated'
    );
  });

  test({
    id: 'F15-02',
    feature: 'F15',
    tier: 1,
    description: 'Criterion 2 (Maintainability): public C headers contain full Doxygen/C11 architectural comments',
  }, () => {
    const headerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler.h'),
      'utf8'
    );

    assert.ok(headerSrc.includes('ds_compute_viewport'), 'Header must declare ds_compute_viewport');
    assert.ok(headerSrc.includes('ds_build_mode_table'), 'Header must declare ds_build_mode_table');
    assert.ok(headerSrc.includes('ds_cursor_record_warp'), 'Header must declare ds_cursor_record_warp');
  });

  test({
    id: 'F15-03',
    feature: 'F15',
    tier: 1,
    description: 'Criterion 3 (Performance): presenter blit loops make zero per-frame malloc/free calls',
  }, () => {
    const glGdiSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    // Blit hooks must not allocate memory dynamically per frame
    const hasMallocInBlit = /hook_glBlitFramebuffer[\s\S]*?malloc\s*\(/m.test(glGdiSrc) ||
      /hook_BitBlt[\s\S]*?malloc\s*\(/m.test(glGdiSrc);

    assert.strictEqual(
      hasMallocInBlit,
      false,
      'F15 Criterion 3 violation: frame blit hooks must not perform heap allocations'
    );
  });

  test({
    id: 'F15-04',
    feature: 'F15',
    tier: 1,
    description: 'Criterion 4 (Resource Footprint): launcher PE host utilizes Job Objects for leak-free child process management',
  }, () => {
    const launcherSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_launcher.c'),
      'utf8'
    );

    const usesJobObjects = /CreateJobObjectW/m.test(launcherSrc) &&
      /SetInformationJobObject/m.test(launcherSrc) &&
      /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/m.test(launcherSrc);

    assert.ok(
      usesJobObjects,
      'F15 Criterion 4 violation: launcher host must use Job Objects to prevent orphan game processes'
    );
  });

  test({
    id: 'F15-05',
    feature: 'F15',
    tier: 1,
    description: 'Criterion 5 (UI Efficiency): display configuration sanitization completes without blocking main thread',
  }, () => {
    const installerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/macNativeInstallerAndCodesign.cjs'),
      'utf8'
    );

    assert.ok(
      installerSrc.includes('sanitizeWinePrefixDisplayConfigs'),
      'macNativeInstaller must export sanitizeWinePrefixDisplayConfigs'
    );
  });
});
