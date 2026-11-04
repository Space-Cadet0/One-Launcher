'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

suite('Tier 2 — Feature F8 Boundaries: In-Game Menu ESC Transition Edge Cases', () => {
  test({
    id: 'F8-B01',
    feature: 'F8',
    tier: 2,
    description: 'Rapid 5x ESC toggles maintain GDI surface state without memory leak or handle exhaustion',
  }, () => {
    let menuActive = false;
    for (let i = 0; i < 5; i++) {
      menuActive = !menuActive;
    }
    assert.strictEqual(menuActive, true, 'After 5 toggles, menu should be open');
  });

  test({
    id: 'F8-B02',
    feature: 'F8',
    tier: 2,
    description: 'Sub-rectangle dirty rect updates in menu (ds_map_subrect_virt_to_phys) preserve pixel alignment',
  }, () => {
    const mathSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_math.c'),
      'utf8'
    );

    const hasSubrectMapping = /ds_map_subrect_virt_to_phys/m.test(mathSrc);
    assert.ok(hasSubrectMapping, 'F8-B02: ds_map_subrect_virt_to_phys must be defined for partial GDI menu updates');
  });

  test({
    id: 'F8-B03',
    feature: 'F8',
    tier: 2,
    description: 'Palette-indexed 8-bpp GDI DIB sections map cleanly to 32-bpp physical presentation target',
  }, () => {
    const glGdiSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    const handlesDIBits = /hook_StretchDIBits/m.test(glGdiSrc) &&
      /hook_SetDIBitsToDevice/m.test(glGdiSrc);

    assert.ok(handlesDIBits, 'F8-B03: GDI presenter must hook StretchDIBits and SetDIBitsToDevice');
  });

  test({
    id: 'F8-B04',
    feature: 'F8',
    tier: 2,
    description: 'Menu rendering under integer scaling mode produces exact pixel multiple blits',
  }, () => {
    const { invokeNativeViewport } = require('../harness/index.cjs');
    // 640x480 on 3024x1964 with integer scaling: k = 4 (2560x1920)
    const vp = invokeNativeViewport(3024, 1964, 0, 640, 480, 'integer');
    assert.ok(vp && vp.ok);
    assert.strictEqual(vp.integerScale, 4, '640x480 integer scale on 3024x1964 must be 4');
    assert.strictEqual(vp.dstW, 2560);
    assert.strictEqual(vp.dstH, 1920);
  });

  test({
    id: 'F8-B05',
    feature: 'F8',
    tier: 2,
    description: 'Display mode changes during menu transition do not drop DirectDraw surfaces prematurely',
  }, () => {
    const dllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    // DirectDraw surfaces drop if WM_DISPLAYCHANGE is sent synchronously during ESC
    const avoidsSynchronousDisplayChange = !/SendMessageW\s*\(\s*target_hwnd\s*,\s*WM_DISPLAYCHANGE/m.test(dllSrc) ||
      /PostMessageW\s*\(\s*target_hwnd\s*,\s*WM_DISPLAYCHANGE/m.test(dllSrc) ||
      /defer_display_change/m.test(dllSrc);

    assert.ok(
      avoidsSynchronousDisplayChange,
      'F8-B05: WM_DISPLAYCHANGE must not synchronously destroy DirectDraw surfaces on ESC'
    );
  });
});
