'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, beforeEach, afterEach, assert, makeTempDir, cleanupTempDirs, createSyntheticBottle } = require('../harness/index.cjs');

const macNativeInstaller = require('../../../electron/launcher/macNativeInstallerAndCodesign.cjs');

suite('Tier 1 — Feature F1: Elimination of OneLauncherBackdropWnd & Display Shields', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir('f1-test');
  });

  afterEach(() => {
    cleanupTempDirs();
  });

  test({
    id: 'F1-01',
    feature: 'F1',
    tier: 1,
    description: 'Registry generation sets CaptureDisplaysForFullscreen="n" for fullscreen bottled games',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'JK.EXE',
      { crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const userRegContent = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userRegContent, /"CaptureDisplaysForFullscreen"="n"/i,
      'F1 contract violation: CaptureDisplaysForFullscreen must be "n" to avoid CGDisplayCapture hardware shield locks');
  });

  test({
    id: 'F1-02',
    feature: 'F1',
    tier: 1,
    description: 'Registry generation sets CaptureDisplaysForFullscreen="n" for legacy DirectDraw games',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'JK.EXE',
      { usesLegacyDirectDraw: true, crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const userRegContent = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userRegContent, /"CaptureDisplaysForFullscreen"="n"/i,
      'F1 contract violation: legacy DirectDraw games must have CaptureDisplaysForFullscreen="n"');
  });

  test({
    id: 'F1-03',
    feature: 'F1',
    tier: 1,
    description: 'Display scaler window implementation eliminates OneLauncherBackdropWnd class definition',
  }, () => {
    const windowCPath = path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c');
    const source = fs.readFileSync(windowCPath, 'utf8');

    const hasBackdropWnd = /DS_BACKDROP_CLASS_W\s+L"OneLauncherBackdropWnd"/i.test(source) &&
      !source.includes('/* REMOVED: OneLauncherBackdropWnd */');

    assert.strictEqual(
      hasBackdropWnd,
      false,
      'F1 contract violation: OneLauncherBackdropWnd must be eliminated from display_scaler_window.c'
    );
  });

  test({
    id: 'F1-04',
    feature: 'F1',
    tier: 1,
    description: 'Primary game window bounds span full physical panel (0, 0, screen_w, screen_h)',
  }, () => {
    const windowCPath = path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c');
    const source = fs.readFileSync(windowCPath, 'utf8');

    // Contract: SetWindowPos must cover (0, 0, screen_w, screen_h)
    const coversFullPanel = /SetWindowPos\s*\(\s*hwnd[^,]*,\s*HWND_TOPMOST\s*,\s*0\s*,\s*0\s*,\s*g_ds\.real_screen_w\s*,\s*g_ds\.real_screen_h/m.test(source) ||
      /SetWindowPos\s*\(\s*hwnd[^,]*,\s*HWND_TOPMOST\s*,\s*0\s*,\s*0\s*,\s*screen_w\s*,\s*screen_h/m.test(source);

    assert.ok(
      coversFullPanel,
      'F1 contract violation: hwnd_game must cover (0, 0, real_screen_w, real_screen_h) to auto-hide macOS menu bar and dock'
    );
  });

  test({
    id: 'F1-05',
    feature: 'F1',
    tier: 1,
    description: 'Window presentation sets black background brush to prevent margin paint bleed',
  }, () => {
    const windowCPath = path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c');
    const source = fs.readFileSync(windowCPath, 'utf8');

    const usesBlackBrush = /BLACK_BRUSH/i.test(source) &&
      /SetClassLongPtrW\s*\(\s*hwnd\s*,\s*GCLP_HBRBACKGROUND/i.test(source);

    assert.ok(
      usesBlackBrush,
      'F1 contract violation: game window class brush must be set to BLACK_BRUSH to avoid white margins'
    );
  });
});
