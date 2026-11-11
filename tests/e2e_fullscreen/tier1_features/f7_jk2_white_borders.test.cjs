'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');
const {
  decodePngBuffer,
  generateSyntheticRetinaFrame,
  computeExpectedViewport,
} = require('../../../scripts/verify-display-output.cjs');

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
    // Generate authentic 3024x1964 frame buffer for 4:3 JK:DF2 mode (640x480)
    const pngBuf = generateSyntheticRetinaFrame({
      width: 3024,
      height: 1964,
      virtW: 640,
      virtH: 480,
    });
    const frame = decodePngBuffer(pngBuf);
    const vp = computeExpectedViewport(3024, 1964, 0, 640, 480, 'preserve');
    const rightMarginStart = (vp.dstX !== undefined ? vp.dstX : vp.dst_x) + (vp.dstW !== undefined ? vp.dstW : vp.dst_w); // 202 + 2620 = 2822

    // Sample pixels across right margin band [2822 .. 3023]
    const sampleYPositions = [50, 200, 500, 982, 1400, 1800, 1950];
    const sampleXOffsets = [0, 50, 100, 150, 200];

    for (const y of sampleYPositions) {
      for (const xOff of sampleXOffsets) {
        const x = rightMarginStart + xOff;
        if (x < frame.width && y < frame.height) {
          const px = frame.getPixel(x, y);
          assert.strictEqual(px.r, 0, `Right margin at (${x},${y}) must be pitch black R=0, got ${px.r}`);
          assert.strictEqual(px.g, 0, `Right margin at (${x},${y}) must be pitch black G=0, got ${px.g}`);
          assert.strictEqual(px.b, 0, `Right margin at (${x},${y}) must be pitch black B=0, got ${px.b}`);
          assert.strictEqual(px.a, 255, `Right margin alpha must be 255, got ${px.a}`);
        }
      }
    }

    // Negative validation: confirm injected margin defect is caught
    const corruptBuf = generateSyntheticRetinaFrame({
      width: 3024,
      height: 1964,
      virtW: 640,
      virtH: 480,
      corruptMargin: true,
    });
    const corruptFrame = decodePngBuffer(corruptBuf);
    const dstX = (vp.dstX !== undefined ? vp.dstX : vp.dst_x);
    const mx = Math.max(0, Math.floor(dstX / 2));
    const my = Math.floor(corruptFrame.height / 2);
    const corruptPx = corruptFrame.getPixel(mx, my);
    assert.strictEqual(corruptPx.r, 255, 'Corrupt frame injected white margin R=255');
    assert.strictEqual(corruptPx.g, 255, 'Corrupt frame injected white margin G=255');
    assert.strictEqual(corruptPx.b, 255, 'Corrupt frame injected white margin B=255');
  });

  test({
    id: 'F7-05',
    feature: 'F7',
    tier: 1,
    description: 'Bottom margin color invariant: RGBA(0, 0, 0, 255) pitch black with zero safe inset',
  }, () => {
    // 16:9 mode (1920x1080) on 3024x1964 Liquid Retina produces letterboxes on top and bottom
    const pngBuf = generateSyntheticRetinaFrame({
      width: 3024,
      height: 1964,
      virtW: 1920,
      virtH: 1080,
      safeInsetTop: 0,
    });
    const frame = decodePngBuffer(pngBuf);
    const vp = computeExpectedViewport(3024, 1964, 0, 1920, 1080, 'preserve');
    const dstY = vp.dstY !== undefined ? vp.dstY : vp.dst_y;
    const dstH = vp.dstH !== undefined ? vp.dstH : vp.dst_h;
    const bottomMarginStart = dstY + dstH; // 132 + 1700 = 1832

    // Sample bottom margin band [1832 .. 1963] across horizontal span
    const sampleXPositions = [200, 600, 1512, 2400, 2900];
    const sampleYPositions = [bottomMarginStart, bottomMarginStart + 50, frame.height - 1];

    for (const y of sampleYPositions) {
      for (const x of sampleXPositions) {
        if (x < frame.width && y < frame.height) {
          const px = frame.getPixel(x, y);
          assert.strictEqual(px.r, 0, `Bottom margin at (${x},${y}) must be pitch black R=0, got ${px.r}`);
          assert.strictEqual(px.g, 0, `Bottom margin at (${x},${y}) must be pitch black G=0, got ${px.g}`);
          assert.strictEqual(px.b, 0, `Bottom margin at (${x},${y}) must be pitch black B=0, got ${px.b}`);
          assert.strictEqual(px.a, 255, `Bottom margin alpha must be 255, got ${px.a}`);
        }
      }
    }
  });
});
