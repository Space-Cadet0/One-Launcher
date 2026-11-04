'use strict';

const { suite, test, assert, invokeNativeViewport } = require('../harness/index.cjs');

suite('Tier 2 — Feature F4 Boundaries: Symmetric Panel & Aspect Ratio Limits', () => {
  test({
    id: 'F4-B01',
    feature: 'F4',
    tier: 2,
    description: '16:9 mode on 3024x1964 panel naturally clears MacBook notch (top margin >= 74px notch)',
  }, () => {
    // 16:9 (e.g. 1920x1080 or 1280x720) on 3024x1964 screen with safe_inset_top = 0
    const vp = invokeNativeViewport(3024, 1964, 0, 1920, 1080, 'preserve');
    assert.ok(vp && vp.ok);

    const topMargin = vp.dstY;
    const notchHeightPx = 74; // Max MacBook Pro 14"/16" physical notch height

    assert.ok(
      topMargin >= notchHeightPx,
      `F4-B01: 16:9 symmetric letterbox top margin (${topMargin}px) must exceed physical notch height (${notchHeightPx}px)`
    );
  });

  test({
    id: 'F4-B02',
    feature: 'F4',
    tier: 2,
    description: 'Integer scaling mode centers symmetrically without vertical shift',
  }, () => {
    // 320x240 on 3024x1964 screen -> integer scale k = min(3024/320, 1964/240) = min(9.45, 8.18) = 8
    const vp = invokeNativeViewport(3024, 1964, 0, 320, 240, 'integer');
    assert.ok(vp && vp.ok);

    assert.strictEqual(vp.integerScale, 8, 'Integer scale factor must be 8');
    assert.strictEqual(vp.dstW, 2560, 'dstW must be 320 * 8 = 2560');
    assert.strictEqual(vp.dstH, 1920, 'dstH must be 240 * 8 = 1920');

    const expectedDstX = Math.floor((3024 - 2560) / 2); // 232
    const expectedDstY = Math.floor((1964 - 1920) / 2); // 22

    assert.strictEqual(vp.dstX, expectedDstX);
    assert.strictEqual(vp.dstY, expectedDstY);
  });

  test({
    id: 'F4-B03',
    feature: 'F4',
    tier: 2,
    description: 'Stretch scaling mode fills full panel (0, 0, screen_w, screen_h) with zero offsets',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, 0, 640, 480, 'stretch');
    assert.ok(vp && vp.ok);

    assert.strictEqual(vp.dstX, 0);
    assert.strictEqual(vp.dstY, 0);
    assert.strictEqual(vp.dstW, 3024);
    assert.strictEqual(vp.dstH, 1964);
  });

  test({
    id: 'F4-B04',
    feature: 'F4',
    tier: 2,
    description: 'Negative safe_inset_top parameter is clamped strictly to 0',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, -50, 640, 480, 'preserve');
    assert.ok(vp && vp.ok);

    assert.strictEqual(vp.usableY, 0, 'Negative safe_inset_top must clamp usableY to 0');
    assert.strictEqual(vp.usableH, 1964, 'Negative safe_inset_top must preserve full usableH');
  });

  test({
    id: 'F4-B05',
    feature: 'F4',
    tier: 2,
    description: 'Extreme ultrawide 21:9 mode (2560x1080) produces symmetric top and bottom letterbox margins',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, 0, 2560, 1080, 'preserve');
    assert.ok(vp && vp.ok);

    const topMargin = vp.dstY;
    const bottomMargin = 1964 - (vp.dstY + vp.dstH);

    assert.ok(Math.abs(topMargin - bottomMargin) <= 1, 'Top and bottom letterbox bars must match');
  });
});
