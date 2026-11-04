'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, beforeEach, afterEach, assert, makeTempDir, cleanupTempDirs, createSyntheticBottle } = require('../harness/index.cjs');

const macNativeInstaller = require('../../../electron/launcher/macNativeInstallerAndCodesign.cjs');

suite('Tier 2 — Feature F2 Boundaries: HiDPI & Resolution Policy Limits', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir('f2-boundary');
  });

  afterEach(() => {
    cleanupTempDirs();
  });

  test({
    id: 'F2-B01',
    feature: 'F2',
    tier: 2,
    description: 'Explicit override crossoverHighResolutionMode: true generates RetinaMode="y" and LogPixels=192 (0xc0)',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'app.exe',
      { crossoverHighResolutionMode: true, crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userReg, /"RetinaMode"="y"/i);
    assert.match(userReg, /"LogPixels"=dword:000000c0/i);
  });

  test({
    id: 'F2-B02',
    feature: 'F2',
    tier: 2,
    description: 'Undefined crossoverHighResolutionMode defaults strictly to RetinaMode="y"',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'test.exe',
      { crossoverHighResolutionMode: undefined, crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userReg, /"RetinaMode"="y"/i);
  });

  test({
    id: 'F2-B03',
    feature: 'F2',
    tier: 2,
    description: 'Legacy DirectDraw game with crossoverHighResolutionMode: false strictly respects false override',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'JK.EXE',
      { usesLegacyDirectDraw: true, crossoverHighResolutionMode: false, crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userReg, /"RetinaMode"="n"/i);
    assert.match(userReg, /"LogPixels"=dword:00000060/i);
  });

  test({
    id: 'F2-B04',
    feature: 'F2',
    tier: 2,
    description: 'Unmanaged bottle with legacy RetinaMode="n" upgrades to "y" on fullscreen launch',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'), {
      userRegMacDriver: '"RetinaMode"="n"\n"CaptureDisplaysForFullscreen"="n"',
    });

    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'game.exe',
      { crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userReg, /"RetinaMode"="y"/i,
      'F2-B04: Default fullscreen launch must heal unmanaged RetinaMode="n" to "y"');
  });

  test({
    id: 'F2-B05',
    feature: 'F2',
    tier: 2,
    description: 'Display scaler native screen dimension probe rejects zero or negative display metrics',
  }, () => {
    const { invokeNativeViewport } = require('../harness/index.cjs');
    // Negative or 0 screen dimensions must be rejected
    const vp1 = invokeNativeViewport(0, 1964, 0, 640, 480, 'preserve');
    const vp2 = invokeNativeViewport(3024, 0, 0, 640, 480, 'preserve');

    assert.strictEqual(vp1, null, 'Viewport with 0 screen width must return null');
    assert.strictEqual(vp2, null, 'Viewport with 0 screen height must return null');
  });
});
