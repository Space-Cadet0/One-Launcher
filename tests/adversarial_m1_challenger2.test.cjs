'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const macNativeInstaller = require('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const {
  verifyDisplayOutput,
  encodePng,
  decodePng,
  computeOracleViewport,
  generateSyntheticDisplayBuffer,
  computeViewportLuminance,
} = require('../scripts/verify-display-output.cjs');

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

// ============================================================================
// TRACK 3: Whole-Display Verifier Adversarial Defect Injection Torture
// ============================================================================
console.log('\n--- TRACK 3: Whole-Display Verifier Defect Injection Torture ---');

runTest('Track 3.1: Horizontal offset defect (+1px shift) strictly detected and rejected', () => {
  const buf = generateSyntheticDisplayBuffer({ defect: 'offset' });
  const report = verifyDisplayOutput({ imageBuffer: buf });
  assert.strictEqual(report.ok, false, 'Verifier must reject 1px horizontal offset shift');
  assert.ok(
    report.metrics.centeringDelta > 0 || report.metrics.marginViolations > 0,
    'Must report centering delta or margin violations'
  );
  assert.strictEqual(report.exitCode, 1, 'Verification failure must set exitCode 1');
});

runTest('Track 3.2: Horizontal offset defect (-1px shift) strictly detected and rejected', () => {
  const w = 3024;
  const h = 1964;
  const oracle = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const shiftedX = oracle.dstX - 1; // shifted left by 1px
  for (let y = oracle.dstY; y < oracle.dstY + oracle.dstH; y++) {
    const rowOffset = y * w * 4;
    for (let x = shiftedX; x < shiftedX + oracle.dstW; x++) {
      const idx = rowOffset + (x * 4);
      rgba[idx] = 100;
      rgba[idx + 1] = 120;
      rgba[idx + 2] = 140;
    }
  }
  const report = verifyDisplayOutput({ imageBuffer: encodePng(w, h, rgba) });
  assert.strictEqual(report.ok, false, 'Verifier must reject negative 1px horizontal offset shift');
  assert.ok(report.metrics.centeringDelta > 0 || report.metrics.marginViolations > 0);
  assert.strictEqual(report.exitCode, 1);
});

runTest('Track 3.3: Vertical offset defect (+1px shift in letterbox mode) strictly detected and rejected', () => {
  const vertOffsetFrame = generateSyntheticDisplayBuffer({
    defect: 'vertical_offset',
    screenW: 3024,
    screenH: 1964,
    virtW: 1920,
    virtH: 1080,
  });
  const report = verifyDisplayOutput({
    imageBuffer: vertOffsetFrame,
    screenW: 3024,
    screenH: 1964,
    virtW: 1920,
    virtH: 1080,
  });
  assert.strictEqual(report.ok, false, 'Verifier must reject 1px vertical offset shift');
  assert.strictEqual(report.metrics.verticalCenteringDelta, 1, 'Must report 1px vertical centering delta');
  assert.strictEqual(report.metrics.centeringDelta, 1, 'Chebyshev centering error must be 1px');
  assert.strictEqual(report.exitCode, 1);
});

runTest('Track 3.4: Vertical offset defect (-1px shift in letterbox mode) strictly detected and rejected', () => {
  const w = 3024;
  const h = 1964;
  const oracle = computeOracleViewport(w, h, 0, 1920, 1080, 'preserve');
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const shiftedY = oracle.dstY - 1; // shifted up by 1px
  for (let y = shiftedY; y < shiftedY + oracle.dstH; y++) {
    const rowOffset = y * w * 4;
    for (let x = oracle.dstX; x < oracle.dstX + oracle.dstW; x++) {
      const idx = rowOffset + (x * 4);
      rgba[idx] = 100;
      rgba[idx + 1] = 120;
      rgba[idx + 2] = 140;
    }
  }
  const report = verifyDisplayOutput({
    imageBuffer: encodePng(w, h, rgba),
    virtualWidth: 1920,
    virtualHeight: 1080,
  });
  assert.strictEqual(report.ok, false, 'Verifier must reject negative 1px vertical offset shift');
  assert.strictEqual(report.metrics.verticalCenteringDelta, 1);
  assert.strictEqual(report.exitCode, 1);
});

runTest('Track 3.5: Margin white bleed in left and right pillarbox margins strictly rejected', () => {
  const report = verifyDisplayOutput({
    imageBuffer: generateSyntheticDisplayBuffer({ defect: 'margin_white' }),
  });
  assert.strictEqual(report.ok, false, 'Verifier must reject white pixels in margins');
  assert.ok(report.metrics.marginViolations > 0, 'Must record positive margin violations');
  assert.strictEqual(report.isPureBlackMargins, false, 'isPureBlackMargins must be false');
  assert.strictEqual(report.exitCode, 1);
});

runTest('Track 3.6: macOS Menu Bar bleed across top 0..44px margin boundary strictly flagged and rejected', () => {
  for (const testY of [0, 22, 44]) {
    const w = 3024;
    const h = 1964;
    const buf = generateSyntheticDisplayBuffer({ width: w, height: h });
    const decoded = decodePng(buf);
    const midLeftMarginX = 50;
    const idx = (testY * w + midLeftMarginX) * 4;
    decoded.data[idx] = 200;
    decoded.data[idx + 1] = 200;
    decoded.data[idx + 2] = 200;

    const report = verifyDisplayOutput({ imageBuffer: encodePng(w, h, decoded.data) });
    assert.strictEqual(report.ok, false, `Must reject menu bar bleed at y=${testY}`);
    assert.strictEqual(report.metrics.menuBarBleed, true, `menuBarBleed must be true at y=${testY}`);
    assert.ok(report.errors.some(e => e.includes('Menu Bar')), `Error must mention Menu Bar at y=${testY}`);
  }
});

runTest('Track 3.7: macOS Dock bleed across bottom 60px margin boundary strictly flagged and rejected', () => {
  for (const offset of [0, 30, 59]) {
    const w = 3024;
    const h = 1964;
    const testY = h - 60 + offset;
    const buf = generateSyntheticDisplayBuffer({ width: w, height: h });
    const decoded = decodePng(buf);
    const midLeftMarginX = 50;
    const idx = (testY * w + midLeftMarginX) * 4;
    decoded.data[idx] = 180;
    decoded.data[idx + 1] = 180;
    decoded.data[idx + 2] = 180;

    const report = verifyDisplayOutput({ imageBuffer: encodePng(w, h, decoded.data) });
    assert.strictEqual(report.ok, false, `Must reject dock bleed at y=${testY}`);
    assert.strictEqual(report.metrics.dockBleed, true, `dockBleed must be true at y=${testY}`);
    assert.ok(report.errors.some(e => e.includes('Dock')), `Error must mention Dock at y=${testY}`);
  }
});

runTest('Track 3.8: All-black unrendered frame in aspect-preserving pillarbox mode strictly evaluates to 0.0 luminance and fails', () => {
  const blackBuf = encodePng(3024, 1964, Buffer.alloc(3024 * 1964 * 4, 0));
  const report = verifyDisplayOutput({ imageBuffer: blackBuf });
  assert.strictEqual(report.metrics.avgLuminance, 0, 'Perceived luminance must be strictly 0.0');
  assert.strictEqual(report.ok, false, 'Verifier must reject unrendered all-black frame in pillarbox mode');
  assert.strictEqual(report.exitCode, 1);
});

runTest('Track 3.9: All-black frame in stretch mode strictly rejected with zero luminance', () => {
  const blackBuf = encodePng(3024, 1964, Buffer.alloc(3024 * 1964 * 4, 0));
  const stretchReport = verifyDisplayOutput({ imageBuffer: blackBuf, aspectMode: 'stretch' });
  assert.strictEqual(stretchReport.metrics.avgLuminance, 0, 'Luminance is strictly 0.0');
  assert.strictEqual(stretchReport.ok, false, 'Verifier must reject all-black stretch frame');
  assert.strictEqual(stretchReport.passed, false, 'passed must be false');
  assert.strictEqual(stretchReport.exitCode, 1, 'Failed verification must yield exitCode 1');
  assert.ok(
    stretchReport.summary.includes('zero luminance') || stretchReport.errors.some(e => e.includes('zero luminance')),
    'Summary or errors must indicate zero luminance'
  );
});

// ============================================================================
// TRACK 4: Whole-Display Verifier Edge Robustness & Texture Fuzzing
// ============================================================================
console.log('\n--- TRACK 4: Whole-Display Verifier Edge Robustness & Texture Fuzzing ---');

runTest('Track 4.1: Dark border pixels resilience: single dark pixel at midline boundary passes without spurious false rejection', () => {
  const w = 3024;
  const h = 1964;
  const vp = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = vp.dstY; y < vp.dstY + vp.dstH; y++) {
    for (let x = vp.dstX; x < vp.dstX + vp.dstW; x++) {
      const idx = (y * w + x) * 4;
      rgba[idx] = 120;
      rgba[idx + 1] = 120;
      rgba[idx + 2] = 120;
      rgba[idx + 3] = 255;
    }
  }
  // Single dark pixel at midline
  const darkIdx = (Math.floor(h / 2) * w + vp.dstX) * 4;
  rgba[darkIdx] = 0;
  rgba[darkIdx + 1] = 0;
  rgba[darkIdx + 2] = 0;

  const report = verifyDisplayOutput({ imageBuffer: encodePng(w, h, rgba) });
  assert.strictEqual(report.ok, true, 'Multi-row edge detection must not falsely reject dark midline pixel');
  assert.strictEqual(report.metrics.centeringDelta, 0, 'Centering delta must remain 0px');
  assert.strictEqual(report.leftEdgeClean, true);
});

runTest('Track 4.2: Distributed multi-row resilience: 1, 2, 4, and 8 of 9 sampled rows having dark edge pixels pass cleanly', () => {
  const w = 3024;
  const h = 1964;
  const vp = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
  const rowSampleCount = Math.min(9, Math.max(1, vp.dstH - 2));
  const sampleRows = [];
  for (let i = 1; i <= rowSampleCount; i++) {
    sampleRows.push(vp.dstY + Math.floor((vp.dstH * i) / (rowSampleCount + 1)));
  }

  for (const darkCount of [1, 2, 4, 8]) {
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = vp.dstY; y < vp.dstY + vp.dstH; y++) {
      for (let x = vp.dstX; x < vp.dstX + vp.dstW; x++) {
        const idx = (y * w + x) * 4;
        rgba[idx] = 130;
        rgba[idx + 1] = 130;
        rgba[idx + 2] = 130;
        rgba[idx + 3] = 255;
      }
    }
    for (let k = 0; k < darkCount; k++) {
      const y = sampleRows[k];
      const idx = (y * w + vp.dstX) * 4;
      rgba[idx] = 0;
      rgba[idx + 1] = 0;
      rgba[idx + 2] = 0;
    }
    const report = verifyDisplayOutput({ imageBuffer: encodePng(w, h, rgba) });
    assert.strictEqual(report.ok, true, `${darkCount} dark sampled rows must pass`);
    assert.strictEqual(report.metrics.centeringDelta, 0);
    assert.strictEqual(report.leftEdgeClean, true);
  }
});

runTest('Track 4.3: Dark border threshold test: when ALL 9 sampled rows have dark edge pixels, verifier advances measured boundary', () => {
  const w = 3024;
  const h = 1964;
  const vp = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
  const rowSampleCount = Math.min(9, Math.max(1, vp.dstH - 2));
  const sampleRows = [];
  for (let i = 1; i <= rowSampleCount; i++) {
    sampleRows.push(vp.dstY + Math.floor((vp.dstH * i) / (rowSampleCount + 1)));
  }

  const rgba = Buffer.alloc(w * h * 4);
  for (let y = vp.dstY; y < vp.dstY + vp.dstH; y++) {
    for (let x = vp.dstX; x < vp.dstX + vp.dstW; x++) {
      const idx = (y * w + x) * 4;
      rgba[idx] = 130;
      rgba[idx + 1] = 130;
      rgba[idx + 2] = 130;
      rgba[idx + 3] = 255;
    }
  }
  // Set all 9 sampled rows to dark at dstX
  for (let k = 0; k < 9; k++) {
    const y = sampleRows[k];
    const idx = (y * w + vp.dstX) * 4;
    rgba[idx] = 0;
    rgba[idx + 1] = 0;
    rgba[idx + 2] = 0;
  }
  const report = verifyDisplayOutput({ imageBuffer: encodePng(w, h, rgba) });
  assert.strictEqual(report.ok, false, '9 dark sampled rows advances boundary and triggers failure');
  assert.strictEqual(report.metrics.centeringDelta, 1);
  assert.strictEqual(report.leftEdgeClean, false);
});

runTest('Track 4.4: Faint 1-bit outer margin bleed rejection: RGB(0, 0, 1) at (0, 0) strictly caught', () => {
  const buf = generateSyntheticDisplayBuffer();
  const decoded = decodePng(buf);
  decoded.data[2] = 1; // B = 1 at (0, 0)
  const report = verifyDisplayOutput({ imageBuffer: encodePng(decoded.width, decoded.height, decoded.data) });
  assert.strictEqual(report.ok, false, '1-bit faint bleed must be caught');
  assert.ok(report.metrics.marginViolations >= 1);
  assert.strictEqual(report.metrics.menuBarBleed, true);
});

runTest('Track 4.5: Faint 1-bit outer margin bleed adjacent to viewport (dstX - 1, midY) with RGB(1, 0, 0) strictly caught', () => {
  const w = 3024;
  const h = 1964;
  const vp = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
  const buf = generateSyntheticDisplayBuffer({ width: w, height: h });
  const decoded = decodePng(buf);
  const midY = Math.floor(h / 2);
  const idx = (midY * w + (vp.dstX - 1)) * 4;
  decoded.data[idx] = 1; // R = 1
  const report = verifyDisplayOutput({ imageBuffer: encodePng(w, h, decoded.data) });
  assert.strictEqual(report.ok, false, '1-bit faint bleed adjacent to viewport must be caught');
  assert.ok(report.metrics.marginViolations >= 1);
  assert.strictEqual(report.leftEdgeClean, false);
});

runTest('Track 4.6: Faint 1-bit outer margin bleed at (dstX + dstW, height - 10) with RGB(0, 1, 0) strictly caught', () => {
  const w = 3024;
  const h = 1964;
  const vp = computeOracleViewport(w, h, 0, 640, 480, 'preserve');
  const buf = generateSyntheticDisplayBuffer({ width: w, height: h });
  const decoded = decodePng(buf);
  const targetY = h - 10;
  const idx = (targetY * w + (vp.dstX + vp.dstW)) * 4;
  decoded.data[idx + 1] = 1; // G = 1
  const report = verifyDisplayOutput({ imageBuffer: encodePng(w, h, decoded.data) });
  assert.strictEqual(report.ok, false, '1-bit faint bleed in right bottom margin must be caught');
  assert.ok(report.metrics.marginViolations >= 1);
  assert.strictEqual(report.metrics.dockBleed, true);
});

runTest('Track 4.7: Faint 1-bit bleed in top and bottom letterbox margins strictly caught', () => {
  const w = 3024;
  const h = 1964;
  const buf = generateSyntheticDisplayBuffer({ width: w, height: h, gameW: 1920, gameH: 1080 });
  const decoded = decodePng(buf);
  // Top letterbox margin at (100, 5)
  const topIdx = (5 * w + 100) * 4;
  decoded.data[topIdx + 2] = 1; // B = 1
  // Bottom letterbox margin at (100, 1950)
  const botIdx = (1950 * w + 100) * 4;
  decoded.data[botIdx] = 1; // R = 1

  const report = verifyDisplayOutput({
    imageBuffer: encodePng(w, h, decoded.data),
    virtualWidth: 1920,
    virtualHeight: 1080,
  });
  assert.strictEqual(report.ok, false, 'Faint letterbox bleeds must be caught');
  assert.ok(report.metrics.marginViolations >= 2);
});

// ============================================================================
// TRACK 5: Whole-Display Verifier Corrupt & Hostile Inputs Resilience
// ============================================================================
console.log('\n--- TRACK 5: Whole-Display Verifier Corrupt & Hostile Inputs Resilience ---');

runTest('Track 5.1: Zero-length buffer fails gracefully without crashing', () => {
  const report = verifyDisplayOutput({ imageBuffer: Buffer.alloc(0) });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.exitCode, 2);
  assert.ok(report.error.includes('PNG'));
});

runTest('Track 5.2: Truncated PNG header (< 8 bytes) fails gracefully', () => {
  const report = verifyDisplayOutput({ imageBuffer: Buffer.from([0x89, 0x50, 0x4e]) });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.exitCode, 2);
  assert.strictEqual(report.error, 'Invalid PNG signature');
});

runTest('Track 5.3: Truncated IHDR chunk header fails gracefully', () => {
  const truncated = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  ]);
  const report = verifyDisplayOutput({ imageBuffer: truncated });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.exitCode, 2);
  assert.ok(report.error.includes('Truncated'));
});

runTest('Track 5.4: Missing IDAT chunks fails gracefully', () => {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(100, 0);
  ihdrData.writeUInt32BE(100, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(13, 0);
  const typeBuf = Buffer.from('IHDR');
  const crcBuf = Buffer.alloc(4);
  const iendLen = Buffer.alloc(4);
  const iendType = Buffer.from('IEND');
  const iendCrc = Buffer.alloc(4);

  const missingIdat = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    lenBuf, typeBuf, ihdrData, crcBuf,
    iendLen, iendType, iendCrc,
  ]);
  const report = verifyDisplayOutput({ imageBuffer: missingIdat });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.exitCode, 2);
  assert.ok(report.error.includes('No IDAT chunks found'));
});

runTest('Track 5.5: Corrupt IDAT zlib payload fails gracefully', () => {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(100, 0);
  ihdrData.writeUInt32BE(100, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(13, 0);
  const typeBuf = Buffer.from('IHDR');
  const crcBuf = Buffer.alloc(4);

  const badIdatData = Buffer.from('this is totally corrupt non-zlib payload');
  const idatLen = Buffer.alloc(4); idatLen.writeUInt32BE(badIdatData.length, 0);
  const idatType = Buffer.from('IDAT');
  const iendLen = Buffer.alloc(4);
  const iendType = Buffer.from('IEND');
  const iendCrc = Buffer.alloc(4);

  const corruptPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    lenBuf, typeBuf, ihdrData, crcBuf,
    idatLen, idatType, badIdatData, crcBuf,
    iendLen, iendType, iendCrc,
  ]);
  const report = verifyDisplayOutput({ imageBuffer: corruptPng });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.exitCode, 2);
  assert.ok(report.error.includes('header check') || report.error.includes('zlib'));
});

runTest('Track 5.6: Unsupported PNG formats (16-bit, paletted, interlaced) fail gracefully', () => {
  function makePngHeader(depth, colorType, interlace) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const len = Buffer.alloc(4); len.writeUInt32BE(13, 0);
    const type = Buffer.from('IHDR');
    const data = Buffer.alloc(13);
    data.writeUInt32BE(100, 0);
    data.writeUInt32BE(100, 4);
    data.writeUInt8(depth, 8);
    data.writeUInt8(colorType, 9);
    data.writeUInt8(0, 10);
    data.writeUInt8(0, 11);
    data.writeUInt8(interlace, 12);
    const crc = Buffer.alloc(4);
    return Buffer.concat([sig, len, type, data, crc]);
  }

  // 16-bit depth
  const r1 = verifyDisplayOutput({ imageBuffer: makePngHeader(16, 6, 0) });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.exitCode, 2);
  assert.ok(r1.error.includes('Unsupported bit depth'));

  // Paletted colorType 3
  const r2 = verifyDisplayOutput({ imageBuffer: makePngHeader(8, 3, 0) });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.exitCode, 2);
  assert.ok(r2.error.includes('Unsupported color type'));

  // Interlaced
  const r3 = verifyDisplayOutput({ imageBuffer: makePngHeader(8, 6, 1) });
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.exitCode, 2);
  assert.ok(r3.error.includes('Interlaced'));
});

runTest('Track 5.7: Non-existent image file fails gracefully with clear error', () => {
  const missingPath = path.join(os.tmpdir(), `nonexistent-img-${Date.now()}.png`);
  const report = verifyDisplayOutput({ image: missingPath });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.exitCode, 2);
  assert.ok(report.error.includes('does not exist'));
});

runTest('Track 5.8: Extreme resolution scaling: 8K (7680x4320) synthetic frame verified under 1000ms without OOM', () => {
  const t0 = Date.now();
  const report = verifyDisplayOutput({
    synthetic: true,
    displayWidth: 7680,
    displayHeight: 4320,
    virtualWidth: 1920,
    virtualHeight: 1080,
  });
  const elapsed = Date.now() - t0;
  assert.strictEqual(report.ok, true, '8K verification must pass');
  assert.strictEqual(report.displayWidth, 7680);
  assert.strictEqual(report.displayHeight, 4320);
  assert.ok(elapsed < 1000, `8K verification must complete under 1000ms (took ${elapsed}ms)`);
});

runTest('Track 5.9: Extreme resolution scaling: Low-res 320x200 synthetic frame verified cleanly', () => {
  const report = verifyDisplayOutput({
    synthetic: true,
    displayWidth: 320,
    displayHeight: 200,
    virtualWidth: 320,
    virtualHeight: 200,
  });
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.displayWidth, 320);
  assert.strictEqual(report.displayHeight, 200);
});

runTest('Track 5.10: Extreme display aspect ratios: Ultra-wide 5120x1440 verified cleanly', () => {
  const report = verifyDisplayOutput({
    synthetic: true,
    displayWidth: 5120,
    displayHeight: 1440,
    virtualWidth: 1920,
    virtualHeight: 1080,
  });
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.displayWidth, 5120);
  assert.strictEqual(report.displayHeight, 1440);
  assert.strictEqual(report.centeringErrorPx, 0);
});

runTest('Track 5.11: Hostile CLI invocation resilience (non-PNG file, missing file, defect flags, negative dimensions probe)', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/verify-display-output.cjs');

  // Subprocess test: Missing file -> exitCode 2
  try {
    execFileSync(process.execPath, [scriptPath, '--image=/nonexistent_test_screenshot.png'], { stdio: 'pipe' });
    assert.fail('Should have exited with non-zero');
  } catch (err) {
    assert.strictEqual(err.status, 2, 'Missing file CLI invocation must exit with code 2');
  }

  // Subprocess test: Non-PNG file -> exitCode 2
  const fakeFile = path.join(os.tmpdir(), `fake-img-${Date.now()}.png`);
  fs.writeFileSync(fakeFile, 'plain text content');
  try {
    try {
      execFileSync(process.execPath, [scriptPath, `--image=${fakeFile}`], { stdio: 'pipe' });
      assert.fail('Should have exited with non-zero');
    } catch (err) {
      assert.strictEqual(err.status, 2, 'Non-PNG file CLI invocation must exit with code 2');
    }
  } finally {
    try { fs.unlinkSync(fakeFile); } catch {}
  }

  // Subprocess test: Defect offset -> exitCode 1
  try {
    execFileSync(process.execPath, [scriptPath, '--synthetic', '--defect=offset'], { stdio: 'pipe' });
    assert.fail('Should have exited with non-zero');
  } catch (err) {
    assert.strictEqual(err.status, 1, 'Defect offset CLI invocation must exit with code 1');
  }

  // Subprocess test: Defect dock_bleed -> exitCode 1
  try {
    execFileSync(process.execPath, [scriptPath, '--synthetic', '--defect=dock_bleed'], { stdio: 'pipe' });
    assert.fail('Should have exited with non-zero');
  } catch (err) {
    assert.strictEqual(err.status, 1, 'Defect dock_bleed CLI invocation must exit with code 1');
  }

  // Subprocess test: Negative dimensions exit gracefully with exitCode 2 without crashing
  try {
    execFileSync(process.execPath, [scriptPath, '--game-res=-10x-20'], { stdio: 'pipe' });
    assert.fail('Should have failed');
  } catch (err) {
    assert.strictEqual(err.status, 2, 'Negative resolution must cause CLI exit code 2');
    const stderr = err.stderr ? err.stderr.toString() : '';
    assert.ok(
      stderr.includes('Failed to compute expected viewport geometry') || stderr.includes('ERROR:'),
      'Stderr captures graceful failure'
    );
    assert.ok(!stderr.includes('throw new Error'), 'Must not crash with uncaught throw');
  }
});

runTest('Track 5.12: Programmatic invalid/negative resolution handling returns graceful error', () => {
  const report = verifyDisplayOutput({ virtualWidth: -10, virtualHeight: -20 });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.passed, false);
  assert.strictEqual(report.exitCode, 2);
  assert.ok(report.error.includes('Failed to compute expected viewport geometry'));
});

// ============================================================================
// TRACK 6: Turnkey CLI & Live / Screenshot Verification
// ============================================================================
console.log('\n--- TRACK 6: Turnkey CLI & Live / Screenshot Verification ---');

runTest('Track 6.1: Turnkey verification of reference screenshot verified_jk_3d_hidpi_pillarbox.png passes with 0 violations', () => {
  const refPath = process.env.ONELAUNCHER_TEST_REF_SCREENSHOT || path.join(os.tmpdir(), 'verified_jk_3d_hidpi_pillarbox.png');
  if (fs.existsSync(refPath)) {
    const report = verifyDisplayOutput({
      image: refPath,
      virtualWidth: 640,
      virtualHeight: 480,
    });
    assert.strictEqual(report.ok, true, 'Reference screenshot must pass verification');
    assert.strictEqual(report.displayWidth, 3024);
    assert.strictEqual(report.displayHeight, 1964);
    assert.strictEqual(report.centeringErrorPx, 0, 'Centering error must be 0px');
    assert.strictEqual(report.totalMarginViolations, 0, 'Margin violations must be 0');
    assert.strictEqual(report.menuBarBleed, false, 'menuBarBleed must be false');
    assert.strictEqual(report.dockBleed, false, 'dockBleed must be false');
  } else {
    console.log(' (skipped: reference screenshot not present on filesystem)');
  }
});

runTest('Track 6.2: Turnkey --synthetic verification passes with exit code 0 and valid JSON output', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/verify-display-output.cjs');
  const out = execFileSync(process.execPath, [scriptPath, '--synthetic', '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.passed, true);
  assert.strictEqual(parsed.displayWidth, 3024);
  assert.strictEqual(parsed.displayHeight, 1964);
  assert.strictEqual(parsed.centeringErrorPx, 0);
  assert.strictEqual(parsed.totalMarginViolations, 0);
});

runTest('Track 6.3: C11 Oracle concordance across diverse resolution pairs', () => {
  const screenW = 3024;
  const screenH = 1964;
  const testPairs = [
    { virtW: 640, virtH: 480, expDstW: 2620, expDstH: 1964, expDstX: 202, expDstY: 0 },
    { virtW: 800, virtH: 600, expDstW: 2620, expDstH: 1964, expDstX: 202, expDstY: 0 },
    { virtW: 1024, virtH: 768, expDstW: 2620, expDstH: 1964, expDstX: 202, expDstY: 0 },
    { virtW: 1280, virtH: 720, expDstW: 3024, expDstH: 1700, expDstX: 0, expDstY: 132 },
    { virtW: 1920, virtH: 1080, expDstW: 3024, expDstH: 1700, expDstX: 0, expDstY: 132 },
  ];

  for (const pair of testPairs) {
    const vp = computeOracleViewport(screenW, screenH, 0, pair.virtW, pair.virtH, 'preserve');
    assert.strictEqual(vp.dstW, pair.expDstW, `dstW mismatch for ${pair.virtW}x${pair.virtH}`);
    assert.strictEqual(vp.dstH, pair.expDstH, `dstH mismatch for ${pair.virtW}x${pair.virtH}`);
    assert.strictEqual(vp.dstX, pair.expDstX, `dstX mismatch for ${pair.virtW}x${pair.virtH}`);
    assert.strictEqual(vp.dstY, pair.expDstY, `dstY mismatch for ${pair.virtW}x${pair.virtH}`);
    assert.strictEqual((vp.dstH & 1), 0, `dstH must be even for ${pair.virtW}x${pair.virtH}`);
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
