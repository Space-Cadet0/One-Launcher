'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, beforeEach, afterEach, assert, makeTempDir, cleanupTempDirs, createSyntheticBottle } = require('../harness/index.cjs');

const macNativeInstaller = require('../../../electron/launcher/macNativeInstallerAndCodesign.cjs');

suite('Tier 2 — Feature F1 Boundaries: Backdrop & Display Shield Edge Cases', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir('f1-boundary');
  });

  afterEach(() => {
    cleanupTempDirs();
  });

  test({
    id: 'F1-B01',
    feature: 'F1',
    tier: 2,
    description: 'Corrupted prior user.reg with CaptureDisplaysForFullscreen="y" is healed to "n"',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'), {
      userRegMacDriver: '"RetinaMode"="y"\n"CaptureDisplaysForFullscreen"="y"',
    });

    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'JK.EXE',
      { crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const updated = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(updated, /"CaptureDisplaysForFullscreen"="n"/i,
      'F1-B01: Prior "y" capture setting must be healed to "n"');
  });

  test({
    id: 'F1-B02',
    feature: 'F1',
    tier: 2,
    description: 'AppDefaults per-executable overrides across multiple targets consistently set CaptureDisplaysForFullscreen="n"',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      ['JK.EXE', 'JKG.EXE'],
      { crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userReg, /\[Software\\\\Wine\\\\AppDefaults\\\\JK\.EXE\\\\Mac Driver\][\s\S]*?"CaptureDisplaysForFullscreen"="n"/im);
    assert.match(userReg, /\[Software\\\\Wine\\\\AppDefaults\\\\JKG\.EXE\\\\Mac Driver\][\s\S]*?"CaptureDisplaysForFullscreen"="n"/im);
  });

  test({
    id: 'F1-B03',
    feature: 'F1',
    tier: 2,
    description: 'Windowed scaling mode explicitly preserves CaptureDisplaysForFullscreen="n"',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'quake3.exe',
      { crossoverDisplayScalingMode: 'windowed' },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userReg, /"CaptureDisplaysForFullscreen"="n"/i);
  });

  test({
    id: 'F1-B04',
    feature: 'F1',
    tier: 2,
    description: 'Fresh bottle with empty Mac Driver section initializes CaptureDisplaysForFullscreen="n"',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'), {
      userRegMacDriver: '',
    });

    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'game.exe',
      { crossoverDisplayScalingMode: 'force_fullscreen' },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userReg, /"CaptureDisplaysForFullscreen"="n"/i);
  });

  test({
    id: 'F1-B05',
    feature: 'F1',
    tier: 2,
    description: 'Display scaler window manager handles secondary monitor display metrics without backdrop recreation',
  }, () => {
    const windowSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    // Multi-monitor: monitors must not spawn additional backdrop windows
    const hasBackdropMultiMon = /ds_backdrop_wndproc/m.test(windowSrc) &&
      !windowSrc.includes('/* REMOVED: OneLauncherBackdropWnd */');

    assert.strictEqual(
      hasBackdropMultiMon,
      false,
      'F1-B05: Multi-monitor display handling must not invoke backdrop window procedures'
    );
  });
});
