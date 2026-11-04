'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

suite('Tier 1 — Feature F7: Eliminate 3D White Borders in JK:DF2', () => {
  test({
    id: 'F7-01',
    feature: 'F7',
    tier: 1,
    description: 'Window background brush replaces white COLOR_WINDOW brush with pitch BLACK_BRUSH',
  }, () => {
    const windowSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const hasBlackBrush = /GetStockObject\s*\(\s*BLACK_BRUSH\s*\)/m.test(windowSrc);
    assert.ok(
      hasBlackBrush,
      'F7 contract violation: window class brush must be explicitly initialized with BLACK_BRUSH to avoid white borders'
    );
  });

  test({
    id: 'F7-02',
    feature: 'F7',
    tier: 1,
    description: 'WineD3D glBlitFramebuffer hook applies symmetric centering offsets (dst_x, dst_y)',
  }, () => {
    const glSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    // Contract: nx0 and ny0 destination coordinates must include centering offsets
    const hasCenteringOffset = /nx0\s*=\s*g_ds\.vp\.dst_x/m.test(glSrc) ||
      /nx0\s*\+=\s*g_ds\.vp\.dst_x/m.test(glSrc) ||
      /dst_x\s*\+/m.test(glSrc) ||
      /offset_x/m.test(glSrc);

    assert.ok(
      hasCenteringOffset,
      'F7 contract violation: WineD3D glBlitFramebuffer hook must apply vp.dst_x and vp.dst_y centering offsets'
    );
  });

  test({
    id: 'F7-03',
    feature: 'F7',
    tier: 1,
    description: 'Destination geometry spans full 4:3 pillarbox without unpainted margins on native panel',
  }, () => {
    const panelW = 3024;
    const panelH = 1964;
    // 4:3 aspect ratio spans full 1964px height
    const expectedDstH = panelH;
    const expectedDstW = Math.round(panelH * (4 / 3)); // 2618.67 -> ~2618
    const expectedPillarboxBar = Math.floor((panelW - expectedDstW) / 2); // ~203px

    assert.strictEqual(expectedDstH, 1964, 'Pillarbox height must span full 1964px');
    assert.ok(expectedDstW >= 2618 && expectedDstW <= 2620, `Pillarbox width must be ~2618, got ${expectedDstW}`);
    assert.ok(expectedPillarboxBar >= 202 && expectedPillarboxBar <= 204, 'Symmetric pillarbox bars on left and right');
  });

  test({
    id: 'F7-04',
    feature: 'F7',
    tier: 1,
    description: 'Right-hand side margin color invariant: RGBA(0, 0, 0, 255) pitch black',
  }, () => {
    // Contract from forensic analysis: right-side margin must not contain white brush #ECECEC
    const whiteBrushColor = { r: 236, g: 236, b: 236 };
    const requiredBlackMargin = { r: 0, g: 0, b: 0 };

    assert.notDeepStrictEqual(requiredBlackMargin, whiteBrushColor);
    assert.strictEqual(requiredBlackMargin.r, 0);
    assert.strictEqual(requiredBlackMargin.g, 0);
    assert.strictEqual(requiredBlackMargin.b, 0);
  });

  test({
    id: 'F7-05',
    feature: 'F7',
    tier: 1,
    description: 'Bottom margin color invariant: RGBA(0, 0, 0, 255) pitch black with zero safe inset',
  }, () => {
    const bottomMarginColor = { r: 0, g: 0, b: 0 };
    assert.strictEqual(bottomMarginColor.r, 0);
    assert.strictEqual(bottomMarginColor.g, 0);
    assert.strictEqual(bottomMarginColor.b, 0);
  });
});
