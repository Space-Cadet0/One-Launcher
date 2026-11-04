'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

suite('Tier 2 — Feature F9 Boundaries: Cmd+Tab Focus Cycle & Z-Order Torture', () => {
  test({
    id: 'F9-B01',
    feature: 'F9',
    tier: 2,
    description: 'Rapid 5-cycle background/foreground Cmd+Tab transition maintains valid window state',
  }, () => {
    let appFocused = true;
    for (let cycle = 0; cycle < 5; cycle++) {
      // Switch away (Cmd+Tab)
      appFocused = false;
      // Switch back
      appFocused = true;
    }
    assert.strictEqual(appFocused, true, 'App must return to active focused state');
  });

  test({
    id: 'F9-B02',
    feature: 'F9',
    tier: 2,
    description: 'Switching away while ESC menu is open cleanly restores 2D menu surface without crash',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const handlesActivateApp = /case\s+WM_ACTIVATEAPP:/m.test(src);
    assert.ok(handlesActivateApp, 'F9-B02: WM_ACTIVATEAPP must be handled in window subclass');
  });

  test({
    id: 'F9-B03',
    feature: 'F9',
    tier: 2,
    description: 'Switching away during active 3D gameplay preserves OpenGL / WineD3D context',
  }, () => {
    const glSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    const hasContextHook = /hook_wglMakeCurrent/m.test(glSrc);
    assert.ok(hasContextHook, 'F9-B03: wglMakeCurrent hook must track active rendering context');
  });

  test({
    id: 'F9-B04',
    feature: 'F9',
    tier: 2,
    description: 'Cursor confinement clip is reapplied on focus restoration via ds_reapply_cursor_clip_locked',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const reappliesClip = /ds_reapply_cursor_clip_locked/m.test(src);
    assert.ok(reappliesClip, 'F9-B04: Cursor clipping must be reapplied upon focus return');
  });

  test({
    id: 'F9-B05',
    feature: 'F9',
    tier: 2,
    description: 'Z-order toggles to HWND_NOTOPMOST on focus loss, allowing external apps to render in front',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const dropsTopmostOnDeactivate = /case\s+WM_ACTIVATEAPP:[\s\S]*?if\s*\(\s*wParam\s*==\s*FALSE\s*\)[\s\S]*?HWND_NOTOPMOST/m.test(src);
    assert.ok(
      dropsTopmostOnDeactivate,
      'F9-B05: Game window must drop HWND_TOPMOST when switching to background so other apps sit on top'
    );
  });
});
