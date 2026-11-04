'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, beforeEach, afterEach, assert, makeTempDir, cleanupTempDirs, createSyntheticBottle } = require('../harness/index.cjs');

const macNativeInstaller = require('../../../electron/launcher/macNativeInstallerAndCodesign.cjs');

suite('Tier 1 — Feature F2: Default HiDPI / Physical Resolution Policy', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir('f2-test');
  });

  afterEach(() => {
    cleanupTempDirs();
  });

  test({
    id: 'F2-01',
    feature: 'F2',
    tier: 1,
    description: 'Default launch configuration sets RetinaMode="y" for legacy DirectDraw games',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'JK.EXE',
      { usesLegacyDirectDraw: true, crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const userRegContent = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userRegContent, /"RetinaMode"="y"/i,
      'F2 contract violation: default policy must enable RetinaMode="y" for DirectDraw titles');
    assert.doesNotMatch(userRegContent, /\[Software\\\\Wine\\\\AppDefaults\\\\JK\.EXE\\\\Mac Driver\]\s*\n"RetinaMode"="n"/im,
      'F2 contract violation: forceLegacy96Dpi must not downgrade per-exe AppDefaults to RetinaMode="n"');
  });

  test({
    id: 'F2-02',
    feature: 'F2',
    tier: 1,
    description: 'Default launch configuration sets RetinaMode="y" for 32-bit legacy OpenGL games',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'quake3.exe',
      { crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const userRegContent = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userRegContent, /"RetinaMode"="y"/i,
      'F2 contract violation: default policy must enable RetinaMode="y" for OpenGL titles');
  });

  test({
    id: 'F2-03',
    feature: 'F2',
    tier: 1,
    description: 'Explicit user override crossoverHighResolutionMode === false produces RetinaMode="n"',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'quake3.exe',
      { crossoverHighResolutionMode: false, crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    const userRegContent = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userRegContent, /"RetinaMode"="n"/i,
      'F2 contract violation: explicit override crossoverHighResolutionMode === false must be honored with RetinaMode="n"');
  });

  test({
    id: 'F2-04',
    feature: 'F2',
    tier: 1,
    description: 'macNativeInstaller removes forceLegacy96Dpi forced downgrade assignment',
  }, () => {
    const installerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/macNativeInstallerAndCodesign.cjs'),
      'utf8'
    );

    const hasForced96DpiDowngrade = /const forceLegacy96Dpi = Boolean\(enableLegacyDisplay \|\| usesLegacyDdraw\);/m.test(installerSrc);
    assert.strictEqual(
      hasForced96DpiDowngrade,
      false,
      'F2 contract violation: forceLegacy96Dpi must be removed to allow default HiDPI virtualization'
    );
  });

  test({
    id: 'F2-05',
    feature: 'F2',
    tier: 1,
    description: 'Session supervisor honors crossoverHighResolutionMode default true without forced legacy inset',
  }, () => {
    const supervisorSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/sessionAndProcessSupervisor.cjs'),
      'utf8'
    );

    const hasForcedLegacyNonRetinaInset = /const isLegacyNonRetinaForInset = Boolean\(/m.test(supervisorSrc);
    assert.strictEqual(
      hasForcedLegacyNonRetinaInset,
      false,
      'F2 contract violation: sessionAndProcessSupervisor must not force isLegacyNonRetinaForInset'
    );
  });
});
