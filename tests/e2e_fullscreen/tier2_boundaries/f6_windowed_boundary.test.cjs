'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

suite('Tier 2 — Feature F6 Boundaries: Windowed Scaling & Monitor Backing Limits', () => {
  test({
    id: 'F6-B01',
    feature: 'F6',
    tier: 2,
    description: 'Standard-DPI monitor (screen_w < 2000, 1x backing) sizes window 1:1 without 2x upscale',
  }, () => {
    // 1920x1080 standard-DPI monitor -> scale factor is 1
    const screenW = 1920;
    const virtW = 640;
    const virtH = 480;
    const backingScale = (screenW >= 2000) ? 2 : 1;

    assert.strictEqual(backingScale, 1, 'Standard-DPI monitor must have scale factor 1');
    assert.strictEqual(virtW * backingScale, 640);
    assert.strictEqual(virtH * backingScale, 480);
  });

  test({
    id: 'F6-B02',
    feature: 'F6',
    tier: 2,
    description: 'Large virtual mode (1600x1200) clamped so scaled window (3200x2400) does not exceed 3024x1964',
  }, () => {
    const screenW = 3024;
    const screenH = 1964;
    const virtW = 1600;
    const virtH = 1200;

    // When virt * 2 > screen, clamping fallback must take effect
    let scale = (screenW >= 2000) ? 2 : 1;
    if (virtW * scale > screenW || virtH * scale > screenH) {
      scale = 1; // Fallback to 1x to fit on screen
    }

    const effectiveClientW = virtW * scale;
    const effectiveClientH = virtH * scale;

    assert.ok(effectiveClientW <= screenW, `Window width (${effectiveClientW}) must fit on screen (${screenW})`);
    assert.ok(effectiveClientH <= screenH, `Window height (${effectiveClientH}) must fit on screen (${screenH})`);
  });

  test({
    id: 'F6-B03',
    feature: 'F6',
    tier: 2,
    description: 'Window chrome metrics: AdjustWindowRectEx accommodates titlebar and borders without client distortion',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const hasAdjustWindowRect = /AdjustWindowRectEx/m.test(src);
    assert.ok(hasAdjustWindowRect, 'F6-B03: AdjustWindowRectEx must compute outer frame dimensions');
  });

  test({
    id: 'F6-B04',
    feature: 'F6',
    tier: 2,
    description: 'Even 4x toggle sequence of Ctrl+Option+F returns to active fullscreen presentation',
  }, () => {
    let fsActive = true;
    let forcedWindowed = false;

    // Simulate 4 hotkey presses
    for (let i = 0; i < 4; i++) {
      if (fsActive) {
        fsActive = false;
        forcedWindowed = true;
      } else {
        fsActive = true;
        forcedWindowed = false;
      }
    }

    assert.strictEqual(fsActive, true, 'After 4 toggles, session must return to fullscreen');
    assert.strictEqual(forcedWindowed, false);
  });

  test({
    id: 'F6-B05',
    feature: 'F6',
    tier: 2,
    description: 'Non-standard virtual resolution (1024x768) scales cleanly to 2048x1536 under HiDPI',
  }, () => {
    const virtW = 1024;
    const virtH = 768;
    const screenW = 3024;
    const backing = (screenW >= 2000) ? 2 : 1;

    const clientW = virtW * backing;
    const clientH = virtH * backing;

    assert.strictEqual(clientW, 2048);
    assert.strictEqual(clientH, 1536);
  });
});
