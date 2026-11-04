'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, invokeNativeViewport, oracleComputeViewport } = require('../harness/index.cjs');

suite('Tier 1 — Feature F4: Pure Edge-to-Edge Symmetric Panel Span', () => {
  test({
    id: 'F4-01',
    feature: 'F4',
    tier: 1,
    description: 'Viewport calculation with safe_inset_top=0 produces 100% symmetric centering',
  }, () => {
    // 3024x1964 screen, 640x480 virtual mode (4:3)
    const vp = invokeNativeViewport(3024, 1964, 0, 640, 480, 'preserve');
    assert.ok(vp && vp.ok, 'Viewport calculation must succeed');

    const expectedDstX = Math.floor((3024 - vp.dstW) / 2);
    const expectedDstY = Math.floor((1964 - vp.dstH) / 2);

    assert.strictEqual(vp.dstX, expectedDstX, 'F4 contract violation: dstX must equal (screen_w - dst_w) / 2');
    assert.strictEqual(vp.dstY, expectedDstY, 'F4 contract violation: dstY must equal (screen_h - dst_h) / 2');
  });

  test({
    id: 'F4-02',
    feature: 'F4',
    tier: 1,
    description: 'Top margin strictly equals bottom margin (guaranteeing Win32 and OpenGL Y equivalence)',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, 0, 1280, 720, 'preserve'); // 16:9 mode on 16:10.4 screen
    assert.ok(vp && vp.ok);

    const topMargin = vp.dstY;
    const bottomMargin = 1964 - (vp.dstY + vp.dstH);

    assert.ok(
      Math.abs(topMargin - bottomMargin) <= 1,
      `F4 contract violation: top margin (${topMargin}) must equal bottom margin (${bottomMargin}) for zero-notch symmetric span`
    );
  });

  test({
    id: 'F4-03',
    feature: 'F4',
    tier: 1,
    description: 'Supervisor passes ONE_LAUNCHER_SAFE_INSET_TOP="0" for pure panel span',
  }, () => {
    const supervisorSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/sessionAndProcessSupervisor.cjs'),
      'utf8'
    );

    // Contract: ONE_LAUNCHER_SAFE_INSET_TOP must be '0' for pure symmetric span
    const passesZeroInset = /ONE_LAUNCHER_SAFE_INSET_TOP:\s*['"]0['"]/m.test(supervisorSrc) ||
      /ONE_LAUNCHER_SAFE_INSET_TOP:\s*String\(0\)/m.test(supervisorSrc) ||
      /safe_inset_top:\s*0/m.test(supervisorSrc);

    assert.ok(
      passesZeroInset,
      'F4 contract violation: supervisor must pass ONE_LAUNCHER_SAFE_INSET_TOP="0"'
    );
  });

  test({
    id: 'F4-04',
    feature: 'F4',
    tier: 1,
    description: 'Control INI generator writes safe_inset_top = 0 under universal fullscreen',
  }, () => {
    const supervisorSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/sessionAndProcessSupervisor.cjs'),
      'utf8'
    );

    const writesZeroSafeInset = /safe_inset_top\s*=\s*0/m.test(supervisorSrc);
    assert.ok(
      writesZeroSafeInset,
      'F4 contract violation: display_ctl INI must write safe_inset_top = 0'
    );
  });

  test({
    id: 'F4-05',
    feature: 'F4',
    tier: 1,
    description: '4:3 mode on native 3024x1964 panel spans full 1964px height with dst_y=0',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, 0, 640, 480, 'preserve');
    assert.ok(vp && vp.ok);

    assert.strictEqual(
      vp.dstH,
      1964,
      `F4 contract violation: 4:3 mode must span full panel height (1964px), got ${vp.dstH}`
    );
    assert.strictEqual(
      vp.dstY,
      0,
      `F4 contract violation: 4:3 mode must have dst_y = 0, got ${vp.dstY}`
    );
    // 1964 * 4 / 3 = 2618.67 -> rounded nearest even = 2618 or 2620
    assert.ok(
      vp.dstW >= 2616 && vp.dstW <= 2620,
      `F4 contract violation: expected 4:3 width ~2618, got ${vp.dstW}`
    );
  });
});
