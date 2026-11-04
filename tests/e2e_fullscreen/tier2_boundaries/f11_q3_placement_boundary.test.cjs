'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, invokeNativeViewport } = require('../harness/index.cjs');

suite('Tier 2 — Feature F11 Boundaries: Quake III Placement & Viewport Edges', () => {
  test({
    id: 'F11-B01',
    feature: 'F11',
    tier: 2,
    description: 'Custom widescreen 16:9 mode in Quake III centers with equal top and bottom letterbox margins',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, 0, 1920, 1080, 'preserve');
    assert.ok(vp && vp.ok);

    const topBar = vp.dstY;
    const botBar = 1964 - (vp.dstY + vp.dstH);

    assert.ok(
      Math.abs(topBar - botBar) <= 1,
      `F11-B01: Top letterbox (${topBar}px) and bottom letterbox (${botBar}px) must be symmetric`
    );
  });

  test({
    id: 'F11-B02',
    feature: 'F11',
    tier: 2,
    description: 'OpenGL filter selection: GL_LINEAR for preserve aspect, GL_NEAREST for integer scaling',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    const selectsFilter = /filter\s*=\s*\(aspect\s*==\s*DS_ASPECT_INTEGER\)\s*\?\s*GL_NEAREST\s*:\s*GL_LINEAR/m.test(src);
    assert.ok(
      selectsFilter,
      'F11-B02: OpenGL FBO presenter must switch to GL_NEAREST for integer mode to preserve crisp pixels'
    );
  });

  test({
    id: 'F11-B03',
    feature: 'F11',
    tier: 2,
    description: 'Non-standard 4:3 resolution (1152x864) centers with even integer pixel boundaries',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, 0, 1152, 864, 'preserve');
    assert.ok(vp && vp.ok);

    assert.strictEqual(vp.dstW % 2, 0, 'Scaled width must be an even integer for clean swapchain blits');
    assert.strictEqual(vp.dstH, 1964, '4:3 mode must span full height');
  });

  test({
    id: 'F11-B04',
    feature: 'F11',
    tier: 2,
    description: 'OpenGL FBO resize event (e.g. from 640x480 to 1024x768) dynamically rebinds texture',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    const handlesFboRecreation = /g_gl\.fbo_w\s*!=\s*virt_w\s*\|\|\s*g_gl\.fbo_h\s*!=\s*virt_h/m.test(src);
    assert.ok(
      handlesFboRecreation,
      'F11-B04: OpenGL presenter must recreate FBO when game virtual resolution changes'
    );
  });

  test({
    id: 'F11-B05',
    feature: 'F11',
    tier: 2,
    description: 'OpenGL scissor test is temporarily disabled during FBO blit and restored immediately after',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    const managesScissor = /g_gl\.p_glDisable\s*\(\s*GL_SCISSOR_TEST\s*\)/m.test(src) &&
      /g_gl\.p_glEnable\s*\(\s*GL_SCISSOR_TEST\s*\)/m.test(src);

    assert.ok(
      managesScissor,
      'F11-B05: OpenGL presenter must disable GL_SCISSOR_TEST during FBO blit to prevent viewport clipping'
    );
  });
});
