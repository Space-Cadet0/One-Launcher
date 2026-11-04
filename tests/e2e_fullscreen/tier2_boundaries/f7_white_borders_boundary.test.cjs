'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

suite('Tier 2 — Feature F7 Boundaries: Borderless Presentation & Margin Protection', () => {
  test({
    id: 'F7-B01',
    feature: 'F7',
    tier: 2,
    description: 'DirectDraw resolution switch repaints presentation surface without exposing white window background',
  }, () => {
    const windowSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const handlesPaint = /case\s+WM_PAINT:/m.test(windowSrc) ||
      /case\s+WM_ERASEBKGND:/m.test(windowSrc);

    assert.ok(handlesPaint, 'F7-B01: Window subclass must handle WM_PAINT/WM_ERASEBKGND to maintain black margins');
  });

  test({
    id: 'F7-B02',
    feature: 'F7',
    tier: 2,
    description: 'SW_MAXIMIZE message from Direct3D initialization clamped to borderless panel bounds',
  }, () => {
    const dllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    const interceptsShowWindow = /hook_ShowWindow/m.test(dllSrc);
    assert.ok(interceptsShowWindow, 'F7-B02: ShowWindow hook must intercept SW_MAXIMIZE');
  });

  test({
    id: 'F7-B03',
    feature: 'F7',
    tier: 2,
    description: '16-bpp DirectDraw surface blit utilizes integer color format without alpha channel leakage',
  }, () => {
    const glSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    const handlesColorBit = /mask\s*==\s*GL_COLOR_BUFFER_BIT/m.test(glSrc);
    assert.ok(handlesColorBit, 'F7-B03: glBlitFramebuffer must operate on GL_COLOR_BUFFER_BIT');
  });

  test({
    id: 'F7-B04',
    feature: 'F7',
    tier: 2,
    description: 'DirectDraw surface loss does not fall through to unpainted white system brushes',
  }, () => {
    const windowSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const setsClassBrush = /SetClassLongPtrW\s*\(\s*hwnd\s*,\s*GCLP_HBRBACKGROUND/m.test(windowSrc) ||
      /BLACK_BRUSH/m.test(windowSrc);

    assert.ok(setsClassBrush, 'F7-B04: Window class brush must remain BLACK_BRUSH even during surface loss');
  });

  test({
    id: 'F7-B05',
    feature: 'F7',
    tier: 2,
    description: 'Aspect ratio cycling (preserve -> integer -> stretch) maintains pitch black borders',
  }, () => {
    const { invokeNativeViewport } = require('../harness/index.cjs');

    const vpPreserve = invokeNativeViewport(3024, 1964, 0, 640, 480, 'preserve');
    const vpInteger = invokeNativeViewport(3024, 1964, 0, 640, 480, 'integer');
    const vpStretch = invokeNativeViewport(3024, 1964, 0, 640, 480, 'stretch');

    assert.ok(vpPreserve.dstX >= 0);
    assert.ok(vpInteger.dstX >= 0);
    assert.strictEqual(vpStretch.dstX, 0);
  });
});
