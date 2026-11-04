'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

suite('Tier 1 — Feature F9: Fix Cmd+Tab Focus Return in JK:DF2', () => {
  test({
    id: 'F9-01',
    feature: 'F9',
    tier: 1,
    description: 'WM_ACTIVATEAPP on wParam == TRUE calls SetForegroundWindow on game window',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const hasSetForeground = /case\s+WM_ACTIVATEAPP:[\s\S]*?SetForegroundWindow\s*\(\s*hwnd\s*\)/m.test(src);
    assert.ok(
      hasSetForeground,
      'F9 contract violation: WM_ACTIVATEAPP on wParam == TRUE must invoke SetForegroundWindow(hwnd)'
    );
  });

  test({
    id: 'F9-02',
    feature: 'F9',
    tier: 1,
    description: 'WM_ACTIVATEAPP on wParam == TRUE calls SetActiveWindow and SetFocus',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const hasActiveAndFocus = /case\s+WM_ACTIVATEAPP:[\s\S]*?SetActiveWindow\s*\(\s*hwnd\s*\)/m.test(src) &&
      /case\s+WM_ACTIVATEAPP:[\s\S]*?SetFocus\s*\(\s*hwnd\s*\)/m.test(src);

    assert.ok(
      hasActiveAndFocus,
      'F9 contract violation: WM_ACTIVATEAPP on wParam == TRUE must invoke SetActiveWindow and SetFocus'
    );
  });

  test({
    id: 'F9-03',
    feature: 'F9',
    tier: 1,
    description: 'WM_ACTIVATEAPP on wParam == FALSE releases cursor clipping cleanly without mode changes',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const releasesClip = /case\s+WM_ACTIVATEAPP:[\s\S]*?if\s*\(\s*wParam\s*==\s*FALSE\s*\)[\s\S]*?ClipCursor\s*\(\s*NULL\s*\)/m.test(src);
    assert.ok(
      releasesClip,
      'F9 contract violation: WM_ACTIVATEAPP on wParam == FALSE must call ClipCursor(NULL)'
    );
  });

  test({
    id: 'F9-04',
    feature: 'F9',
    tier: 1,
    description: 'Focus return eliminates SWP_NOACTIVATE flag when restoring game window',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    // In wParam == TRUE, must not pass SWP_NOACTIVATE to the game window
    const usesNoActivateOnRestore = /case\s+WM_ACTIVATEAPP:[\s\S]*?wParam\s*==\s*TRUE[\s\S]*?SWP_NOACTIVATE/m.test(src) ||
      /case\s+WM_ACTIVATEAPP:[\s\S]*?else\s*\{[\s\S]*?g_ds\.real_SetWindowPos\s*\(\s*hwnd[^;]*SWP_NOACTIVATE/m.test(src);

    assert.strictEqual(
      usesNoActivateOnRestore,
      false,
      'F9 contract violation: game window must NOT receive SWP_NOACTIVATE upon focus restoration'
    );
  });

  test({
    id: 'F9-05',
    feature: 'F9',
    tier: 1,
    description: 'Focus return does not recreate or show secondary backdrop window',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const showsBackdropOnFocus = /case\s+WM_ACTIVATEAPP:[\s\S]*?else\s*\{[\s\S]*?ds_ensure_backdrop_on_current_thread/m.test(src);
    assert.strictEqual(
      showsBackdropOnFocus,
      false,
      'F9 contract violation: WM_ACTIVATEAPP must not recreate or show secondary backdrop window'
    );
  });
});
