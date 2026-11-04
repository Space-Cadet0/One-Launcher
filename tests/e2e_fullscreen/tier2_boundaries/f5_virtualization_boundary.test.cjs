'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { suite, test, beforeEach, afterEach, assert, makeTempDir, cleanupTempDirs, createSyntheticBottle } = require('../harness/index.cjs');

const macNativeInstaller = require('../../../electron/launcher/macNativeInstallerAndCodesign.cjs');

suite('Tier 2 — Feature F5 Boundaries: Config Immutability & Fault Handling', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir('f5-boundary');
  });

  afterEach(() => {
    cleanupTempDirs();
  });

  test({
    id: 'F5-B01',
    feature: 'F5',
    tier: 2,
    description: 'Read-only config file on disk causes no error because sanitization is skipped',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'ReadOnlyGame');
    fs.mkdirSync(gameDir, { recursive: true });

    const cfgPath = path.join(gameDir, 'config.cfg');
    fs.writeFileSync(cfgPath, 'seta r_mode "3"\n', { mode: 0o444 });

    // Must not throw EACCES because under fullscreen, mutating is skipped
    assert.doesNotThrow(() => {
      macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
        installDir: gameDir,
        displayScalingMode: 'auto_fullscreen',
      });
    });
  });

  test({
    id: 'F5-B02',
    feature: 'F5',
    tier: 2,
    description: 'Fresh install with zero existing config files completes cleanly with empty sanitizedFiles',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    const emptyGameDir = path.join(bottle.cDrive, 'Games', 'FreshGame');
    fs.mkdirSync(emptyGameDir, { recursive: true });

    const res = macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: emptyGameDir,
      displayScalingMode: 'auto_fullscreen',
    });

    assert.strictEqual(res.sanitizedFiles.length, 0);
  });

  test({
    id: 'F5-B03',
    feature: 'F5',
    tier: 2,
    description: 'Non-ASCII and binary-adjacent config files retain exact byte content',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'UnicodeGame');
    fs.mkdirSync(gameDir, { recursive: true });

    const cfgPath = path.join(gameDir, 'special.cfg');
    const unicodeContent = '// 日本語コメント\nseta name "玩家"\nseta r_customwidth "1920"\n';
    fs.writeFileSync(cfgPath, unicodeContent, 'utf8');

    macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: gameDir,
      displayScalingMode: 'auto_fullscreen',
    });

    assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), unicodeContent);
  });

  test({
    id: 'F5-B04',
    feature: 'F5',
    tier: 2,
    description: 'Windowed scaling mode does not mutate config files into fullscreen settings',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'WindowedGame');
    fs.mkdirSync(gameDir, { recursive: true });

    const cfgPath = path.join(gameDir, 'q3config.cfg');
    const windowedCfg = 'seta r_fullscreen "0"\nseta r_mode "3"\n';
    fs.writeFileSync(cfgPath, windowedCfg, 'utf8');

    macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: gameDir,
      displayScalingMode: 'windowed',
    });

    const afterCfg = fs.readFileSync(cfgPath, 'utf8');
    assert.match(afterCfg, /seta r_fullscreen "0"/);
  });

  test({
    id: 'F5-B05',
    feature: 'F5',
    tier: 2,
    description: 'SHA-256 hash of game configs remains identical across 10 sequential launch checks',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'HashedGame');
    fs.mkdirSync(gameDir, { recursive: true });

    const cfgPath = path.join(gameDir, 'user.cfg');
    const content = 'bind ESC "togglemenu"\nseta r_mode "4"\n';
    fs.writeFileSync(cfgPath, content, 'utf8');

    const originalHash = crypto.createHash('sha256').update(fs.readFileSync(cfgPath)).digest('hex');

    for (let i = 0; i < 10; i++) {
      macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
        installDir: gameDir,
        displayScalingMode: 'auto_fullscreen',
      });
      const currentHash = crypto.createHash('sha256').update(fs.readFileSync(cfgPath)).digest('hex');
      assert.strictEqual(currentHash, originalHash, `Hash mismatch at iteration ${i}`);
    }
  });
});
