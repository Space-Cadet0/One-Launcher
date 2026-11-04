'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, invokeNativeViewport } = require('../harness/index.cjs');

suite('Tier 1 — Feature F11: Quake III Centered Fullscreen Placement', () => {
  test({
    id: 'F11-01',
    feature: 'F11',
    tier: 1,
    description: 'OpenGL FBO blit destination coordinates use (dst_x, dst_y, dst_x + dst_w, dst_y + dst_h)',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    // Contract: glBlitFramebuffer must blit to (dst_x, dst_y, dst_x + dst_w, dst_y + dst_h)
    const blitsToCenteredDest = /glBlitFramebuffer\s*\([^,]+,[^,]+,[^,]+,[^,]+,\s*(?:g_ds\.vp\.)?dst_x\s*,\s*(?:g_ds\.vp\.)?dst_y\s*,\s*(?:g_ds\.vp\.)?dst_x\s*\+\s*(?:g_ds\.vp\.)?dst_w/m.test(src) ||
      /glBlitFramebuffer\s*\([^,]+,[^,]+,[^,]+,[^,]+,\s*dx0\s*,\s*dy0\s*,\s*dx1\s*,\s*dy1/m.test(src);

    assert.ok(
      blitsToCenteredDest,
      'F11 contract violation: OpenGL glBlitFramebuffer must blit to centered destination coordinates rather than (0, 0, dw, dh)'
    );
  });

  test({
    id: 'F11-02',
    feature: 'F11',
    tier: 1,
    description: 'Symmetric centering places 4:3 Quake III viewport horizontally centered on 3024x1964 panel',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, 0, 640, 480, 'preserve');
    assert.ok(vp && vp.ok);

    const leftBar = vp.dstX;
    const rightBar = 3024 - (vp.dstX + vp.dstW);

    assert.strictEqual(
      leftBar,
      rightBar,
      `F11 contract violation: left pillarbox bar (${leftBar}) must equal right bar (${rightBar})`
    );
  });

  test({
    id: 'F11-03',
    feature: 'F11',
    tier: 1,
    description: 'OpenGL viewport origin is centered vertically with dst_y == (screen_h - dst_h)/2',
  }, () => {
    // 16:9 mode (1280x720) in Quake III
    const vp = invokeNativeViewport(3024, 1964, 0, 1280, 720, 'preserve');
    assert.ok(vp && vp.ok);

    const expectedDstY = Math.floor((1964 - vp.dstH) / 2);
    assert.strictEqual(
      vp.dstY,
      expectedDstY,
      `F11 contract violation: OpenGL vertical destination origin must be symmetrically centered`
    );
  });

  test({
    id: 'F11-04',
    feature: 'F11',
    tier: 1,
    description: 'Quake III resolution switch (mode 3: 640x480 to mode 4: 800x600) maintains centered alignment',
  }, () => {
    const vp1 = invokeNativeViewport(3024, 1964, 0, 640, 480, 'preserve');
    const vp2 = invokeNativeViewport(3024, 1964, 0, 800, 600, 'preserve');

    assert.ok(vp1 && vp1.ok);
    assert.ok(vp2 && vp2.ok);

    assert.strictEqual(vp1.dstX, vp2.dstX, 'Horizontal centering must be invariant across 4:3 virtual resolutions');
    assert.strictEqual(vp1.dstY, vp2.dstY, 'Vertical centering must be invariant across 4:3 virtual resolutions');
    assert.strictEqual(vp1.dstW, vp2.dstW, 'Scaled destination width must match for identical aspect ratios');
  });

  test({
    id: 'F11-05',
    feature: 'F11',
    tier: 1,
    description: 'Display scaler operates in native physical HiDPI pixels, preventing 50% scale offset bug',
  }, () => {
    const dllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    // Contract: Process DPI awareness or physical resolution detection ensures real_screen_w is 3024, not 1512
    const setsDpiAware = /SetProcessDPIAware\s*\(\s*\)/m.test(dllSrc) ||
      /DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE/m.test(dllSrc) ||
      /SetProcessDpiAwareness/m.test(dllSrc);

    assert.ok(
      setsDpiAware,
      'F11 contract violation: display_scaler_dll.c must initialize DPI awareness to prevent 2x coordinate scaling bugs'
    );
  });
});
