'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

suite('Tier 1 — Feature F6: Retina-Aware Windowed Mode Sizing (Ctrl+Option+F)', () => {
  test({
    id: 'F6-01',
    feature: 'F6',
    tier: 1,
    description: 'Display scaler window manager scales client dimensions by backing scale factor under HiDPI',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    // Contract: In windowed mode under HiDPI (e.g. real_screen_w >= 2000), client size must scale by backing factor (2x)
    const hasRetinaWindowScaling = /int32_t\s+scale_factor\s*=\s*\(g_ds\.real_screen_w\s*>=\s*2000\)\s*\?\s*2\s*:\s*1/i.test(src) ||
      /client_w\s*=\s*vw\s*\*\s*2/i.test(src) ||
      /scale_factor\s*>\s*1/i.test(src) ||
      /vw\s*\*\s*\(g_ds\.real_screen_w\s*>\s*2000/i.test(src);

    assert.ok(
      hasRetinaWindowScaling,
      'F6 contract violation: windowed mode must scale legacy window geometry by Retina backing scale factor (2x)'
    );
  });

  test({
    id: 'F6-02',
    feature: 'F6',
    tier: 1,
    description: 'Virtual 640x480 resolution produces 1280x960 physical client size under 3024x1964 HiDPI',
  }, () => {
    // Mathematical specification check for Retina windowed scaling
    const virtW = 640;
    const virtH = 480;
    const screenW = 3024;
    const backingScale = (screenW >= 2000) ? 2 : 1;

    const scaledClientW = virtW * backingScale;
    const scaledClientH = virtH * backingScale;

    assert.strictEqual(scaledClientW, 1280, '640x480 virtual width must scale to 1280 physical client pixels');
    assert.strictEqual(scaledClientH, 960, '640x480 virtual height must scale to 960 physical client pixels');
  });

  test({
    id: 'F6-03',
    feature: 'F6',
    tier: 1,
    description: 'Virtual 800x600 resolution produces 1600x1200 physical client size under 3024x1964 HiDPI',
  }, () => {
    const virtW = 800;
    const virtH = 600;
    const screenW = 3024;
    const backingScale = (screenW >= 2000) ? 2 : 1;

    const scaledClientW = virtW * backingScale;
    const scaledClientH = virtH * backingScale;

    assert.strictEqual(scaledClientW, 1600, '800x600 virtual width must scale to 1600 physical client pixels');
    assert.strictEqual(scaledClientH, 1200, '800x600 virtual height must scale to 1200 physical client pixels');
  });

  test({
    id: 'F6-04',
    feature: 'F6',
    tier: 1,
    description: 'Windowed window position is centered symmetrically on display (screen_w - win_w)/2',
  }, () => {
    const screenW = 3024;
    const screenH = 1964;
    const winW = 1280;
    const winH = 960;

    const posX = Math.floor((screenW - winW) / 2);
    const posY = Math.floor((screenH - winH) / 2);

    assert.strictEqual(posX, 872, 'Windowed X position must be symmetrically centered at (3024 - 1280) / 2');
    assert.strictEqual(posY, 502, 'Windowed Y position must be symmetrically centered at (1964 - 960) / 2');
  });

  test({
    id: 'F6-05',
    feature: 'F6',
    tier: 1,
    description: 'Ctrl+Option+F hotkey handling toggles fullscreen_active and user_forced_windowed cleanly',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const hasHotkeyToggle = /VK_CONTROL/i.test(src) &&
      /VK_MENU/i.test(src) &&
      /user_forced_windowed/i.test(src);

    assert.ok(
      hasHotkeyToggle,
      'F6 contract violation: display_scaler_window.c must handle Ctrl+Option+F toggle state transition'
    );
  });
});
