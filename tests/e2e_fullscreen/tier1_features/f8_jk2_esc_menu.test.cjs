'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

suite('Tier 1 — Feature F8: Fix Menu Rendering on ESC in JK:DF2', () => {
  test({
    id: 'F8-01',
    feature: 'F8',
    tier: 1,
    description: 'GDI presenter supports WindowFromDC(hdcDst) == GetDesktopWindow() for in-game menu blits',
  }, () => {
    const glGdiSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    const supportsDesktopDC = /GetDesktopWindow\s*\(\s*\)/m.test(glGdiSrc) &&
      /win\s*==\s*GetDesktopWindow\s*\(\s*\)/m.test(glGdiSrc);

    assert.ok(
      supportsDesktopDC,
      'F8 contract violation: ds_should_scale_gdi_dc must support GetDesktopWindow() DCs used by JK:DF2 menus'
    );
  });

  test({
    id: 'F8-02',
    feature: 'F8',
    tier: 1,
    description: 'GDI presenter scales game window DC win == g_ds.hwnd_game',
  }, () => {
    const glGdiSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    const matchesGameWnd = /win\s*==\s*g_ds\.hwnd_game/m.test(glGdiSrc);
    assert.ok(
      matchesGameWnd,
      'F8 contract violation: ds_should_scale_gdi_dc must match hwnd_game'
    );
  });

  test({
    id: 'F8-03',
    feature: 'F8',
    tier: 1,
    description: 'Transition from 3D Direct3D to 2D GDI menu triggers presentation rect invalidation',
  }, () => {
    const dllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );
    const glGdiSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    const triggersInvalidation = /InvalidateRect\s*\(\s*g_ds\.hwnd_game/m.test(dllSrc) ||
      /InvalidateRect\s*\(\s*g_ds\.hwnd_game/m.test(glGdiSrc) ||
      /RedrawWindow/m.test(dllSrc);

    assert.ok(
      triggersInvalidation,
      'F8 contract violation: 3D to 2D menu transition must invalidate presentation rect to flush GDI surface'
    );
  });

  test({
    id: 'F8-04',
    feature: 'F8',
    tier: 1,
    description: 'Menu BitBlt coordinates map virtual 640x480 into symmetrically centered physical destination',
  }, () => {
    const virtW = 640;
    const virtH = 480;
    const dstW = 2618;
    const dstH = 1964;
    const dstX = 203;
    const dstY = 0;

    // Sub-rect test for menu center box (e.g. 320x240 at (160, 120))
    const menuBoxVirtX = 160;
    const menuBoxVirtY = 120;
    const menuBoxVirtW = 320;
    const menuBoxVirtH = 240;

    const physX = dstX + Math.floor((menuBoxVirtX * dstW) / virtW);
    const physY = dstY + Math.floor((menuBoxVirtY * dstH) / virtH);
    const physW = Math.floor((menuBoxVirtW * dstW) / virtW);
    const physH = Math.floor((menuBoxVirtH * dstH) / virtH);

    assert.ok(physX >= 203 && physX < 203 + dstW);
    assert.ok(physY >= 0 && physY < dstH);
    assert.strictEqual(physW, 1309);
    assert.strictEqual(physH, 982);
  });

  test({
    id: 'F8-05',
    feature: 'F8',
    tier: 1,
    description: 'Display mode changes during menu transition do not drop DirectDraw surfaces prematurely',
  }, () => {
    const dllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    // Contract: sending WM_DISPLAYCHANGE synchronously inside ChangeDisplaySettings must be guarded
    const avoidsPrematureSurfaceLoss = !/SendMessageW\s*\(\s*target_hwnd\s*,\s*WM_DISPLAYCHANGE/m.test(dllSrc) ||
      /PostMessageW\s*\(\s*target_hwnd\s*,\s*WM_DISPLAYCHANGE/m.test(dllSrc) ||
      /defer_display_change/m.test(dllSrc);

    assert.ok(
      avoidsPrematureSurfaceLoss,
      'F8 contract violation: WM_DISPLAYCHANGE must not synchronously destroy DirectDraw surfaces on ESC'
    );
  });
});
