'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const os = require('node:os');

const macNativeInstaller = require('../electron/launcher/macNativeInstallerAndCodesign.cjs');

// Helpers for test fixture creation
let testTempDir = null;

function setupTempDir() {
  testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger2_m1_'));
  return testTempDir;
}

function cleanupTempDir() {
  if (testTempDir && fs.existsSync(testTempDir)) {
    try {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    } catch {}
    testTempDir = null;
  }
}

function createSyntheticBottle(bottleDir, initialUserRegContent = null) {
  fs.mkdirSync(bottleDir, { recursive: true });
  const cDrive = path.join(bottleDir, 'drive_c');
  const windowsDir = path.join(cDrive, 'windows');
  const system32 = path.join(windowsDir, 'system32');
  const usersDir = path.join(cDrive, 'users', 'crossover');
  fs.mkdirSync(system32, { recursive: true });
  fs.mkdirSync(usersDir, { recursive: true });

  const systemRegPath = path.join(bottleDir, 'system.reg');
  const userRegPath = path.join(bottleDir, 'user.reg');
  const cxbottleConfPath = path.join(bottleDir, 'cxbottle.conf');

  fs.writeFileSync(systemRegPath, 'WINE REGISTRY Version 2\n;; All keys relative to \\\\Machine\n\n', 'utf8');
  const defaultUserReg = initialUserRegContent || [
    'WINE REGISTRY Version 2',
    ';; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000',
    '',
    '[Control Panel\\\\Desktop]',
    '"LogPixels"=dword:00000060',
    '',
    '[Software\\\\Wine\\\\Fonts]',
    '"LogPixels"=dword:00000060',
    '',
    '[Software\\\\Wine\\\\Mac Driver]',
    '"CaptureDisplaysForFullscreen"="n"',
    '',
  ].join('\n');
  fs.writeFileSync(userRegPath, defaultUserReg, 'utf8');
  fs.writeFileSync(cxbottleConfPath, '[EnvironmentVariables]\n', 'utf8');

  return { bottleDir, cDrive, userRegPath, systemRegPath, cxbottleConfPath, usersDir };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let passedCount = 0;
let failedCount = 0;
const testResults = [];

function runTest(name, fn) {
  process.stdout.write(`  TEST: ${name} ... `);
  try {
    fn();
    passedCount++;
    testResults.push({ name, status: 'PASS' });
    console.log('PASS');
  } catch (err) {
    failedCount++;
    testResults.push({ name, status: 'FAIL', error: err });
    console.log('FAIL');
    console.error(`    ${err.stack || err.message}`);
  }
}

console.log('================================================================');
console.log('  CHALLENGER 2: Empirical Stress Harness for Milestone 1');
console.log('================================================================\n');

// ============================================================================
// TRACK 1: Config Sanitization Bypass Under Universal Display Scaling
// ============================================================================
console.log('--- TRACK 1: Config Sanitization Adversarial Stress Tests ---');

runTest('Track 1.1: Quake III Arena .cfg in game dir with hostile 4K resolutions remains 100% byte-identical', () => {
  const root = setupTempDir();
  try {
    const bottle = createSyntheticBottle(path.join(root, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'Quake3', 'baseq3');
    fs.mkdirSync(gameDir, { recursive: true });

    const cfgFile = path.join(gameDir, 'q3config.cfg');
    const originalContent = Buffer.from([
      '// Quake III Arena Configuration',
      'seta r_customwidth "3840"',
      'seta r_customheight "2160"',
      'seta r_mode "-1"',
      'seta r_fullscreen "1"',
      'seta v_width "3840"',
      'seta v_height "2160"',
      'seta r_picmip "0"',
      'seta cg_fov "115"',
    ].join('\r\n'), 'utf8');

    fs.writeFileSync(cfgFile, originalContent);
    const hashBefore = sha256(originalContent);
    const statBefore = fs.statSync(cfgFile);

    const res = macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: path.join(bottle.cDrive, 'Games', 'Quake3'),
      displayScalingMode: 'auto',
      maxWidth: 640,  // Hostile constraint: aggressive downscale clamp
      maxHeight: 480,
    });

    assert.strictEqual(res.sanitizedFiles.length, 0, 'sanitizedFiles must be empty');
    const contentAfter = fs.readFileSync(cfgFile);
    const hashAfter = sha256(contentAfter);
    const statAfter = fs.statSync(cfgFile);

    assert.strictEqual(hashAfter, hashBefore, 'SHA-256 hash must be identical');
    assert.strictEqual(Buffer.compare(contentAfter, originalContent), 0, 'Buffer content must be 100% identical');
    assert.strictEqual(statAfter.size, statBefore.size, 'File size must be identical');
  } finally {
    cleanupTempDir();
  }
});

runTest('Track 1.2: Unreal Engine .ini in Saved Games deeply nested with 8K resolutions remains 100% byte-identical', () => {
  const root = setupTempDir();
  try {
    const bottle = createSyntheticBottle(path.join(root, 'bottle'));
    const savedGamesDir = path.join(bottle.usersDir, 'Saved Games', 'Publisher', 'Title', 'Config', 'WindowsNoEditor');
    fs.mkdirSync(savedGamesDir, { recursive: true });

    const iniFile = path.join(savedGamesDir, 'GameUserSettings.ini');
    const originalContent = Buffer.from([
      '[/Script/Engine.GameUserSettings]',
      'ResolutionSizeX=7680',
      'ResolutionSizeY=4320',
      'LastUserConfirmedResolutionSizeX=7680',
      'LastUserConfirmedResolutionSizeY=4320',
      'DesiredScreenWidth=7680',
      'DesiredScreenHeight=4320',
      'FullscreenMode=0',
    ].join('\n'), 'utf8');

    fs.writeFileSync(iniFile, originalContent);
    const hashBefore = sha256(originalContent);

    const res = macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      displayScalingMode: 'integer',
      maxWidth: 1024,
      maxHeight: 768,
    });

    assert.strictEqual(res.sanitizedFiles.length, 0, 'sanitizedFiles must be empty');
    const contentAfter = fs.readFileSync(iniFile);
    assert.strictEqual(sha256(contentAfter), hashBefore, 'Byte content of deep .ini must not change');
  } finally {
    cleanupTempDir();
  }
});

runTest('Track 1.3: All universal scaling modes (auto, fit, stretch, integer, force_fullscreen, off, native_driver) bypass sanitization', () => {
  const modes = ['auto', 'auto_fullscreen', 'force_fullscreen', 'fit', 'stretch', 'integer', 'native_driver', 'off'];
  for (const mode of modes) {
    const root = setupTempDir();
    try {
      const bottle = createSyntheticBottle(path.join(root, 'bottle'));
      const gameDir = path.join(bottle.cDrive, 'Games', 'TestGame');
      fs.mkdirSync(gameDir, { recursive: true });

      const cfgFile = path.join(gameDir, 'display.cfg');
      const originalCfg = Buffer.from('seta r_customwidth "3024"\nseta r_customheight "1964"\n', 'utf8');
      fs.writeFileSync(cfgFile, originalCfg);

      const iniFile = path.join(gameDir, 'display.ini');
      const originalIni = Buffer.from('[Display]\nResolutionSizeX=3024\nResolutionSizeY=1964\n', 'utf8');
      fs.writeFileSync(iniFile, originalIni);

      const res = macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
        installDir: gameDir,
        displayScalingMode: mode,
        maxWidth: 800,
        maxHeight: 600,
      });

      assert.strictEqual(res.sanitizedFiles.length, 0, `Mode ${mode} must not sanitize files`);
      assert.strictEqual(sha256(fs.readFileSync(cfgFile)), sha256(originalCfg), `Mode ${mode} mutated .cfg`);
      assert.strictEqual(sha256(fs.readFileSync(iniFile)), sha256(originalIni), `Mode ${mode} mutated .ini`);
    } finally {
      cleanupTempDir();
    }
  }
});

runTest('Track 1.4: Fallback option properties (scalingMode, effectiveDisplayScalingMode) also trigger bypass', () => {
  const root = setupTempDir();
  try {
    const bottle = createSyntheticBottle(path.join(root, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'FallbackGame');
    fs.mkdirSync(gameDir, { recursive: true });

    const cfgFile = path.join(gameDir, 'q3config.cfg');
    const originalCfg = Buffer.from('seta r_customwidth "2560"\nseta r_customheight "1440"\n', 'utf8');
    fs.writeFileSync(cfgFile, originalCfg);

    // Test with options.scalingMode
    macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: gameDir,
      scalingMode: 'auto_fullscreen',
      maxWidth: 640,
      maxHeight: 480,
    });
    assert.strictEqual(sha256(fs.readFileSync(cfgFile)), sha256(originalCfg));

    // Test with options.effectiveDisplayScalingMode
    macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: gameDir,
      effectiveDisplayScalingMode: 'force_fullscreen',
      maxWidth: 640,
      maxHeight: 480,
    });
    assert.strictEqual(sha256(fs.readFileSync(cfgFile)), sha256(originalCfg));
  } finally {
    cleanupTempDir();
  }
});

runTest('Track 1.5: Non-universal mode (windowed or undefined) preserves legacy clamping functionality', () => {
  const root = setupTempDir();
  try {
    const bottle = createSyntheticBottle(path.join(root, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'ClampedGame');
    fs.mkdirSync(gameDir, { recursive: true });

    const cfgFile = path.join(gameDir, 'game.cfg');
    const originalCfg = Buffer.from('seta r_customwidth "3000"\nseta r_customheight "2000"\n', 'utf8');
    fs.writeFileSync(cfgFile, originalCfg);

    // When scaling mode is windowed, clamping should activate
    const res = macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: gameDir,
      displayScalingMode: 'windowed',
      maxWidth: 1920,
      maxHeight: 1080,
    });

    assert.strictEqual(res.sanitizedFiles.length, 1, 'Legacy clamping must record 1 sanitized file');
    const mutated = fs.readFileSync(cfgFile, 'utf8');
    assert.match(mutated, /seta r_customwidth "1920"/, 'Must clamp width to 1920');
    assert.match(mutated, /seta r_customheight "1080"/, 'Must clamp height to 1080');
  } finally {
    cleanupTempDir();
  }
});

runTest('Track 1.6: UTF-8 BOM, mixed CRLF line endings, and uppercase extensions (.CFG, .INI) are preserved without corruption', () => {
  const root = setupTempDir();
  try {
    const bottle = createSyntheticBottle(path.join(root, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'BomGame');
    fs.mkdirSync(gameDir, { recursive: true });

    // UTF-8 BOM is EF BB BF
    const bomHeader = Buffer.from([0xEF, 0xBB, 0xBF]);
    const cfgBody = Buffer.from('seta r_customwidth "3024"\r\nseta r_customheight "1964"\r\n', 'utf8');
    const fullBomCfg = Buffer.concat([bomHeader, cfgBody]);

    const upperCfg = path.join(gameDir, 'UPPER.CFG');
    const upperIni = path.join(gameDir, 'UPPER.INI');
    fs.writeFileSync(upperCfg, fullBomCfg);
    fs.writeFileSync(upperIni, fullBomCfg);

    macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: gameDir,
      displayScalingMode: 'auto',
      maxWidth: 640,
      maxHeight: 480,
    });

    assert.strictEqual(sha256(fs.readFileSync(upperCfg)), sha256(fullBomCfg));
    assert.strictEqual(sha256(fs.readFileSync(upperIni)), sha256(fullBomCfg));
  } finally {
    cleanupTempDir();
  }
});

// ============================================================================
// TRACK 2: Explicit User Override Enforcement
// ============================================================================
console.log('\n--- TRACK 2: User Override Enforcement Stress Tests ---');

runTest('Track 2.1: crossoverHighResolutionMode === false enforces RetinaMode="n" and LogPixels=96 (0x60) for 32-bit legacy titles', () => {
  const root = setupTempDir();
  try {
    const bottle = createSyntheticBottle(path.join(root, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'JK.EXE',
      {
        usesLegacyDirectDraw: true,
        enableLegacyDisplayModeSynthesis: true,
        crossoverHighResolutionMode: false,
        crossoverDisplayScalingMode: 'auto',
      },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');

    // Verify [Software\Wine\Mac Driver] has RetinaMode="n"
    assert.match(userReg, /\[Software\\\\Wine\\\\Mac Driver\][\s\S]*?"RetinaMode"="n"/im,
      'Global Mac Driver must have RetinaMode="n"');

    // Verify [Control Panel\Desktop] has LogPixels=dword:00000060 (96 DPI)
    assert.match(userReg, /\[Control Panel\\\\Desktop\][\s\S]*?"LogPixels"=dword:00000060/im,
      'Desktop LogPixels must be 96 DPI (0x60)');

    // Verify [Software\Wine\Fonts] has LogPixels=dword:00000060
    assert.match(userReg, /\[Software\\\\Wine\\\\Fonts\][\s\S]*?"LogPixels"=dword:00000060/im,
      'Wine Fonts LogPixels must be 96 DPI (0x60)');

    // Verify [Software\Wine\AppDefaults\jk.exe\Mac Driver] has RetinaMode="n"
    assert.match(userReg, /\[Software\\\\Wine\\\\AppDefaults\\\\jk\.exe\\\\Mac Driver\][\s\S]*?"RetinaMode"="n"/im,
      'AppDefaults for jk.exe must have RetinaMode="n"');

    // Verify CaptureDisplaysForFullscreen="n"
    assert.match(userReg, /\[Software\\\\Wine\\\\AppDefaults\\\\jk\.exe\\\\Mac Driver\][\s\S]*?"CaptureDisplaysForFullscreen"="n"/im,
      'AppDefaults for jk.exe must have CaptureDisplaysForFullscreen="n"');
  } finally {
    cleanupTempDir();
  }
});

runTest('Track 2.2: crossoverHighResolutionMode === true enforces RetinaMode="y" and LogPixels=192 (0xc0) for 32-bit legacy titles', () => {
  const root = setupTempDir();
  try {
    const bottle = createSyntheticBottle(path.join(root, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'JK.EXE',
      {
        usesLegacyDirectDraw: true,
        enableLegacyDisplayModeSynthesis: true,
        crossoverHighResolutionMode: true,
        crossoverDisplayScalingMode: 'auto',
      },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');

    // Verify [Software\Wine\Mac Driver] has RetinaMode="y"
    assert.match(userReg, /\[Software\\\\Wine\\\\Mac Driver\][\s\S]*?"RetinaMode"="y"/im,
      'Global Mac Driver must have RetinaMode="y"');

    // Verify [Control Panel\Desktop] has LogPixels=dword:000000c0 (192 DPI)
    assert.match(userReg, /\[Control Panel\\\\Desktop\][\s\S]*?"LogPixels"=dword:000000c0/im,
      'Desktop LogPixels must be 192 DPI (0xc0)');

    // Verify [Software\Wine\Fonts] has LogPixels=dword:000000c0
    assert.match(userReg, /\[Software\\\\Wine\\\\Fonts\][\s\S]*?"LogPixels"=dword:000000c0/im,
      'Wine Fonts LogPixels must be 192 DPI (0xc0)');

    // Verify [Software\Wine\AppDefaults\jk.exe\Mac Driver] has RetinaMode="y"
    assert.match(userReg, /\[Software\\\\Wine\\\\AppDefaults\\\\jk\.exe\\\\Mac Driver\][\s\S]*?"RetinaMode"="y"/im,
      'AppDefaults for jk.exe must have RetinaMode="y"');

    // Verify CaptureDisplaysForFullscreen="n"
    assert.match(userReg, /\[Software\\\\Wine\\\\AppDefaults\\\\jk\.exe\\\\Mac Driver\][\s\S]*?"CaptureDisplaysForFullscreen"="n"/im,
      'AppDefaults for jk.exe must have CaptureDisplaysForFullscreen="n"');
  } finally {
    cleanupTempDir();
  }
});

runTest('Track 2.3: crossoverHighResolutionMode === undefined defaults to RetinaMode="y" without 96 DPI downgrade', () => {
  const root = setupTempDir();
  try {
    const bottle = createSyntheticBottle(path.join(root, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'quake3.exe',
      {
        crossoverDisplayScalingMode: 'auto',
        // crossoverHighResolutionMode is intentionally omitted/undefined
      },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');

    // Verify [Software\Wine\AppDefaults\quake3.exe\Mac Driver] has RetinaMode="y"
    assert.match(userReg, /\[Software\\\\Wine\\\\AppDefaults\\\\quake3\.exe\\\\Mac Driver\][\s\S]*?"RetinaMode"="y"/im,
      'AppDefaults for quake3.exe must default to RetinaMode="y"');

    // Verify CaptureDisplaysForFullscreen="n"
    assert.match(userReg, /\[Software\\\\Wine\\\\AppDefaults\\\\quake3\.exe\\\\Mac Driver\][\s\S]*?"CaptureDisplaysForFullscreen"="n"/im,
      'CaptureDisplaysForFullscreen must be "n"');
  } finally {
    cleanupTempDir();
  }
});

runTest('Track 2.4: Dynamic flip sequence: false -> true -> false -> undefined across sequential launches on the same bottle', () => {
  const root = setupTempDir();
  try {
    const bottle = createSyntheticBottle(path.join(root, 'bottle'));

    // Step 1: Launch with false
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'game.exe',
      { crossoverHighResolutionMode: false, crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );
    let reg1 = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(reg1, /\[Software\\\\Wine\\\\AppDefaults\\\\game\.exe\\\\Mac Driver\][\s\S]*?"RetinaMode"="n"/im,
      'Step 1: Must write RetinaMode="n"');
    assert.match(reg1, /"LogPixels"=dword:00000060/im, 'Step 1: Must write 96 DPI');

    // Step 2: Flip to true
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'game.exe',
      { crossoverHighResolutionMode: true, crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );
    let reg2 = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(reg2, /\[Software\\\\Wine\\\\AppDefaults\\\\game\.exe\\\\Mac Driver\][\s\S]*?"RetinaMode"="y"/im,
      'Step 2: Must flip to RetinaMode="y"');
    assert.match(reg2, /"LogPixels"=dword:000000c0/im, 'Step 2: Must flip to 192 DPI');

    // Step 3: Flip back to false
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'game.exe',
      { crossoverHighResolutionMode: false, crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );
    let reg3 = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(reg3, /\[Software\\\\Wine\\\\AppDefaults\\\\game\.exe\\\\Mac Driver\][\s\S]*?"RetinaMode"="n"/im,
      'Step 3: Must revert to RetinaMode="n"');
    assert.match(reg3, /"LogPixels"=dword:00000060/im, 'Step 3: Must revert to 96 DPI');

    // Step 4: Remove override (undefined) -> AppDefaults must heal to "y"
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'game.exe',
      { crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );
    let reg4 = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(reg4, /\[Software\\\\Wine\\\\AppDefaults\\\\game\.exe\\\\Mac Driver\][\s\S]*?"RetinaMode"="y"/im,
      'Step 4: Default launch must set AppDefaults to "y"');
  } finally {
    cleanupTempDir();
  }
});

runTest('Track 2.5: Multiple target exes (targetExeNames: [Launcher.exe, Game.exe]) all receive override setting', () => {
  const root = setupTempDir();
  try {
    const bottle = createSyntheticBottle(path.join(root, 'bottle'));
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'Main.exe',
      {
        targetExeNames: ['Launcher.exe', 'Game.exe'],
        crossoverHighResolutionMode: false,
        crossoverDisplayScalingMode: 'auto',
      },
      bottle.bottleDir
    );

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');
    for (const exe of ['main.exe', 'launcher.exe', 'game.exe']) {
      const regPattern = new RegExp(`\\[Software\\\\\\\\Wine\\\\\\\\AppDefaults\\\\\\\\${exe.replace('.', '\\.')}\\\\\\\\Mac Driver\\][\\s\\S]*?"RetinaMode"="n"`, 'im');
      assert.match(userReg, regPattern, `AppDefaults for ${exe} must have RetinaMode="n"`);
    }
  } finally {
    cleanupTempDir();
  }
});

runTest('Track 2.6: Non-boolean crossoverHighResolutionMode values (null, "false", 0) are treated safely as default true', () => {
  const nonBooleans = [null, 'false', 0, '0'];
  for (const val of nonBooleans) {
    const root = setupTempDir();
    try {
      const bottle = createSyntheticBottle(path.join(root, 'bottle'));
      macNativeInstaller.applyCrossOverPerGameSettings(
        bottle.bottleDir,
        'app.exe',
        {
          crossoverHighResolutionMode: val,
          crossoverDisplayScalingMode: 'auto',
        },
        bottle.bottleDir
      );

      const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');
      assert.match(userReg, /\[Software\\\\Wine\\\\AppDefaults\\\\app\.exe\\\\Mac Driver\][\s\S]*?"RetinaMode"="y"/im,
        `Non-boolean value ${JSON.stringify(val)} must default AppDefaults to RetinaMode="y"`);
    } finally {
      cleanupTempDir();
    }
  }
});

console.log('\n================================================================');
console.log(`Results: ${passedCount} passed, ${failedCount} failed out of ${passedCount + failedCount} tests`);
console.log('================================================================');

if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
