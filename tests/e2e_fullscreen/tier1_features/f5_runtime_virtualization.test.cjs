'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, beforeEach, afterEach, assert, makeTempDir, cleanupTempDirs, createSyntheticBottle } = require('../harness/index.cjs');

const macNativeInstaller = require('../../../electron/launcher/macNativeInstallerAndCodesign.cjs');

suite('Tier 1 — Feature F5: Pure Runtime Win32 Display Virtualization', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir('f5-test');
  });

  afterEach(() => {
    cleanupTempDirs();
  });

  test({
    id: 'F5-01',
    feature: 'F5',
    tier: 1,
    description: 'sanitizeWinePrefixDisplayConfigs skips mutating .cfg files when universal fullscreen is active',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'Quake3', 'baseq3');
    fs.mkdirSync(gameDir, { recursive: true });

    const cfgPath = path.join(gameDir, 'q3config.cfg');
    const originalCfg = [
      '// Quake III Arena user config',
      'seta r_mode "3"',
      'seta r_customwidth "1600"',
      'seta r_customheight "1200"',
      'seta r_fullscreen "1"',
    ].join('\n');
    fs.writeFileSync(cfgPath, originalCfg, 'utf8');

    macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: path.join(bottle.cDrive, 'Games', 'Quake3'),
      displayScalingMode: 'auto_fullscreen',
    });

    const updatedCfg = fs.readFileSync(cfgPath, 'utf8');
    assert.strictEqual(
      updatedCfg,
      originalCfg,
      'F5 contract violation: .cfg files on disk must NOT be mutated when universal fullscreen is active'
    );
  });

  test({
    id: 'F5-02',
    feature: 'F5',
    tier: 1,
    description: 'sanitizeWinePrefixDisplayConfigs skips mutating .ini files when universal fullscreen is active',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'LegacyGame');
    fs.mkdirSync(gameDir, { recursive: true });

    const iniPath = path.join(gameDir, 'game.ini');
    const originalIni = [
      '[DisplaySettings]',
      'ResolutionSizeX=800',
      'ResolutionSizeY=600',
      'Fullscreen=1',
    ].join('\n');
    fs.writeFileSync(iniPath, originalIni, 'utf8');

    macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: gameDir,
      displayScalingMode: 'auto_fullscreen',
    });

    const updatedIni = fs.readFileSync(iniPath, 'utf8');
    assert.strictEqual(
      updatedIni,
      originalIni,
      'F5 contract violation: .ini files on disk must NOT be mutated when universal fullscreen is active'
    );
  });

  test({
    id: 'F5-03',
    feature: 'F5',
    tier: 1,
    description: 'User custom resolution in q3config.cfg remains byte-identical after launch preparation',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    const baseq3Dir = path.join(bottle.cDrive, 'q3', 'baseq3');
    fs.mkdirSync(baseq3Dir, { recursive: true });

    const cfgPath = path.join(baseq3Dir, 'q3config.cfg');
    const customConfig = 'seta r_customwidth "2560"\nseta r_customheight "1440"\n';
    fs.writeFileSync(cfgPath, customConfig, 'utf8');

    const result = macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: path.join(bottle.cDrive, 'q3'),
      displayScalingMode: 'auto_fullscreen',
    });

    assert.strictEqual(
      result.sanitizedFiles.length,
      0,
      'F5 contract violation: sanitizedFiles must be empty when universal fullscreen scaling is active'
    );
    assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), customConfig);
  });

  test({
    id: 'F5-04',
    feature: 'F5',
    tier: 1,
    description: 'STAR WARS Jedi Knight config files remain untouched during display preparation',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    const jkDir = path.join(bottle.cDrive, 'JK');
    fs.mkdirSync(jkDir, { recursive: true });

    const jkConfig = path.join(jkDir, 'display.ini');
    const content = '[Display]\nWidth=640\nHeight=480\n';
    fs.writeFileSync(jkConfig, content, 'utf8');

    macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: jkDir,
      displayScalingMode: 'force_fullscreen',
    });

    assert.strictEqual(fs.readFileSync(jkConfig, 'utf8'), content);
  });

  test({
    id: 'F5-05',
    feature: 'F5',
    tier: 1,
    description: 'macNativeInstaller source code gates regex mutation on !isUpscalerFullscreenMode',
  }, () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/macNativeInstallerAndCodesign.cjs'),
      'utf8'
    );

    const skipsMutationUnderFullscreen = /if\s*\(\s*isUpscalerFullscreenMode\s*\)\s*\{\s*return\s*\{\s*sanitizedFiles:\s*\[\],\s*maxWidth/m.test(src) ||
      /if\s*\(\s*!isUpscalerFullscreenMode\s*\)/m.test(src);

    assert.ok(
      skipsMutationUnderFullscreen,
      'F5 contract violation: sanitizeWinePrefixDisplayConfigs must early return or skip file walking when isUpscalerFullscreenMode is true'
    );
  });
});
