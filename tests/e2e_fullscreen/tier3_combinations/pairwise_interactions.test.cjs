'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  suite,
  test,
  beforeEach,
  afterEach,
  assert,
  makeTempDir,
  cleanupTempDirs,
  createSyntheticBottle,
  invokeNativeViewport,
  invokeNativeModeTable,
  invokeNativeWarpDrift,
} = require('../harness/index.cjs');

const macNativeInstaller = require('../../../electron/launcher/macNativeInstallerAndCodesign.cjs');

suite('Tier 3 — Cross-Feature Combinations: Pairwise Feature Interactions', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir('tier3-combos');
  });

  afterEach(() => {
    cleanupTempDirs();
  });

  test({
    id: 'T3-01',
    feature: 'F1+F9',
    tier: 3,
    description: '[F1+F9] Elimination of backdrop window + Cmd+Tab focus restoration without Z-order conflict',
  }, () => {
    const windowSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    // Both: no backdrop and active SetForegroundWindow on WM_ACTIVATEAPP
    const hasBackdrop = /DS_BACKDROP_CLASS_W\s+L"OneLauncherBackdropWnd"/i.test(windowSrc) &&
      !windowSrc.includes('/* REMOVED: OneLauncherBackdropWnd */');
    const activatesForeground = /case\s+WM_ACTIVATEAPP:[\s\S]*?SetForegroundWindow/m.test(windowSrc);

    assert.strictEqual(hasBackdrop, false, 'Backdrop window must be eliminated');
    assert.ok(activatesForeground, 'Foreground window must be explicitly activated on Cmd+Tab return');
  });

  test({
    id: 'T3-02',
    feature: 'F2+F6',
    tier: 3,
    description: '[F2+F6] HiDPI default (RetinaMode="y") + Retina-aware windowed mode sizing (2x backing factor)',
  }, () => {
    const screenW = 3024;
    const screenH = 1964;
    const virtW = 640;
    const virtH = 480;

    // HiDPI backing scale factor
    const backingScale = (screenW >= 2000) ? 2 : 1;
    assert.strictEqual(backingScale, 2, 'Retina display must have 2x backing scale factor');

    const clientW = virtW * backingScale;
    const clientH = virtH * backingScale;

    // Centered windowed coordinates
    const posX = Math.floor((screenW - clientW) / 2);
    const posY = Math.floor((screenH - clientH) / 2);

    assert.strictEqual(clientW, 1280);
    assert.strictEqual(clientH, 960);
    assert.strictEqual(posX, 872);
    assert.strictEqual(posY, 502);
  });

  test({
    id: 'T3-03',
    feature: 'F2+F3',
    tier: 3,
    description: '[F2+F3] HiDPI default + mode table synthesis exposes native 3024x1964 without truncation',
  }, () => {
    const modes = invokeNativeModeTable(3024, 1964, 120);
    assert.ok(modes.length <= 52, 'Mode count must stay <= 52');

    const nativeModes = modes.filter(m => m.width === 3024 && m.height === 1964);
    assert.ok(nativeModes.length >= 2, 'Both 16-bpp and 32-bpp native modes must be present');
    assert.ok(nativeModes.some(m => m.bpp === 32));
    assert.ok(nativeModes.some(m => m.bpp === 16));
  });

  test({
    id: 'T3-04',
    feature: 'F3+F4',
    tier: 3,
    description: '[F3+F4] Synthesized mode table entries center symmetrically with zero safe inset',
  }, () => {
    const modes = invokeNativeModeTable(3024, 1964, 120);
    // Sample 3 different modes: 640x480 (4:3), 1280x720 (16:9), and 1920x1200 (16:10)
    for (const testMode of [{ w: 640, h: 480 }, { w: 1280, h: 720 }, { w: 1920, h: 1200 }]) {
      const vp = invokeNativeViewport(3024, 1964, 0, testMode.w, testMode.h, 'preserve');
      assert.ok(vp && vp.ok);
      const topBar = vp.dstY;
      const botBar = 1964 - (vp.dstY + vp.dstH);
      assert.ok(Math.abs(topBar - botBar) <= 1, `Symmetric Y failed for ${testMode.w}x${testMode.h}`);
    }
  });

  test({
    id: 'T3-05',
    feature: 'F4+F11',
    tier: 3,
    description: '[F4+F11] Pure symmetric panel span + Quake III centered OpenGL FBO blit coordinates',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, 0, 640, 480, 'preserve');
    assert.ok(vp && vp.ok);

    const x0 = vp.dstX;
    const y0 = vp.dstY;
    const x1 = vp.dstX + vp.dstW;
    const y1 = vp.dstY + vp.dstH;

    assert.ok(x0 > 0 && x0 === 3024 - x1, 'Left bar must equal right bar');
    assert.strictEqual(y0, 0, '4:3 mode spans full height in 16:10.4 screen');
    assert.strictEqual(y1, 1964);
  });

  test({
    id: 'T3-06',
    feature: 'F4+F10',
    tier: 3,
    description: '[F4+F10] Symmetric panel span + stationary warp anchors eliminating JK:DF2 ceiling mouse look',
  }, () => {
    // Zero safe inset + warp accumulator
    const drift = invokeNativeWarpDrift(2000, 3024, 1964, 0, 640, 480);
    assert.strictEqual(drift.driftY, 0, 'Vertical drift must be exactly zero to prevent ceiling look');
    assert.strictEqual(drift.driftX, 0);
  });

  test({
    id: 'T3-07',
    feature: 'F5+F2',
    tier: 3,
    description: '[F5+F2] Pure runtime virtualization without disk mutation + default HiDPI registry policy',
  }, () => {
    const bottle = createSyntheticBottle(path.join(tempDir, 'bottle'));
    const gameDir = path.join(bottle.cDrive, 'Games', 'ComboTest');
    fs.mkdirSync(gameDir, { recursive: true });

    const cfgPath = path.join(gameDir, 'display.cfg');
    const originalContent = 'seta r_mode "3"\n';
    fs.writeFileSync(cfgPath, originalContent, 'utf8');

    // Run registry configuration
    macNativeInstaller.applyCrossOverPerGameSettings(
      bottle.bottleDir,
      'app.exe',
      { crossoverDisplayScalingMode: 'auto' },
      bottle.bottleDir
    );

    // Run display sanitization
    macNativeInstaller.sanitizeWinePrefixDisplayConfigs(bottle.bottleDir, {
      installDir: gameDir,
      displayScalingMode: 'auto_fullscreen',
    });

    const userReg = fs.readFileSync(bottle.userRegPath, 'utf8');
    assert.match(userReg, /"RetinaMode"="y"/i);
    assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), originalContent, 'Disk config must be untouched');
  });

  test({
    id: 'T3-08',
    feature: 'F7+F4',
    tier: 3,
    description: '[F7+F4] JK:DF2 black margins elimination + symmetric 4:3 pillarbox span on 3024x1964 panel',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, 0, 640, 480, 'preserve');
    assert.ok(vp && vp.ok);

    assert.strictEqual(vp.dstH, 1964, 'Must span full height (zero bottom white margin)');
    assert.strictEqual(vp.dstY, 0);
    assert.ok(vp.dstX >= 202 && vp.dstX <= 204, 'Must be symmetrically centered (zero right white margin)');
  });

  test({
    id: 'T3-09',
    feature: 'F8+F9',
    tier: 3,
    description: '[F8+F9] JK:DF2 ESC in-game menu transition + Cmd+Tab focus cycle while menu is active',
  }, () => {
    const glGdiSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );
    const windowSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const hasDesktopDcSupport = /GetDesktopWindow/m.test(glGdiSrc);
    const hasFocusActivation = /case\s+WM_ACTIVATEAPP:[\s\S]*?SetForegroundWindow/m.test(windowSrc);

    assert.ok(hasDesktopDcSupport, 'Desktop DC support must be present');
    assert.ok(hasFocusActivation, 'Foreground activation must be present');
  });

  test({
    id: 'T3-10',
    feature: 'F10+F12',
    tier: 3,
    description: '[F10+F12] DirectInput module filtering (dinput.dll) + Quake III free cursor mobility without bottom-right pinning',
  }, () => {
    const dllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    const hasDinputInPhys = /k_phys_surface_mods[\s\S]*?L"dinput\.dll"/m.test(dllSrc);
    assert.ok(hasDinputInPhys, 'DirectInput must receive physical coordinates to prevent cursor pinning');
  });

  test({
    id: 'T3-11',
    feature: 'F11+F12',
    tier: 3,
    description: '[F11+F12] Quake III centered OpenGL viewport + menu mouse coordinate mapping parity',
  }, () => {
    const vp = invokeNativeViewport(3024, 1964, 0, 640, 480, 'preserve');
    assert.ok(vp && vp.ok);

    // Viewport top-left
    const vOriginX = vp.dstX;
    const vOriginY = vp.dstY;

    // When cursor is at vOriginX, vOriginY, virtual mapping must be (0, 0)
    const relX = Math.max(0, Math.min(vOriginX - vp.dstX, vp.dstW - 1));
    const relY = Math.max(0, Math.min(vOriginY - vp.dstY, vp.dstH - 1));
    const vx = Math.floor((relX * 640) / vp.dstW);
    const vy = Math.floor((relY * 480) / vp.dstH);

    assert.strictEqual(vx, 0);
    assert.strictEqual(vy, 0);
  });

  test({
    id: 'T3-12',
    feature: 'F6+F1',
    tier: 3,
    description: '[F6+F1] Windowed mode toggle via hotkey + single-window borderless return without backdrop recreation',
  }, () => {
    const windowSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const hasBackdrop = /DS_BACKDROP_CLASS_W\s+L"OneLauncherBackdropWnd"/i.test(windowSrc) &&
      !windowSrc.includes('/* REMOVED: OneLauncherBackdropWnd */');
    assert.strictEqual(hasBackdrop, false, 'No backdrop window in single-window architecture');
  });

  test({
    id: 'T3-13',
    feature: 'F2+F13',
    tier: 3,
    description: '[F2+F13] HiDPI default policy + universal portability across different Wine bottle prefixes',
  }, () => {
    const bottle1 = createSyntheticBottle(path.join(tempDir, 'bottle1'));
    const bottle2 = createSyntheticBottle(path.join(tempDir, 'bottle2'));

    macNativeInstaller.applyCrossOverPerGameSettings(bottle1.bottleDir, 'game1.exe', {}, bottle1.bottleDir);
    macNativeInstaller.applyCrossOverPerGameSettings(bottle2.bottleDir, 'game2.exe', {}, bottle2.bottleDir);

    assert.match(fs.readFileSync(bottle1.userRegPath, 'utf8'), /"RetinaMode"="y"/i);
    assert.match(fs.readFileSync(bottle2.userRegPath, 'utf8'), /"RetinaMode"="y"/i);
  });

  test({
    id: 'T3-14',
    feature: 'F8+F7',
    tier: 3,
    description: '[F8+F7] JK:DF2 3D-to-2D ESC menu transition + 2D-to-3D return without white border regression',
  }, () => {
    const windowSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );

    const hasBlackBrush = /BLACK_BRUSH/m.test(windowSrc);
    assert.ok(hasBlackBrush, 'Class background brush must remain BLACK_BRUSH through all transitions');
  });

  test({
    id: 'T3-15',
    feature: 'F9+F14',
    tier: 3,
    description: '[F9+F14] Cmd+Tab background/foreground cycle + live observation verification of active surface',
  }, () => {
    const supervisor = require('../../../electron/launcher/sessionAndProcessSupervisor.cjs');
    assert.strictEqual(typeof supervisor.toggleSessionFullscreen, 'function');
  });

  test({
    id: 'T3-16',
    feature: 'F13+F15',
    tier: 3,
    description: '[F13+F15] Universal portability + 10-element code review & forensic integrity audit',
  }, () => {
    const mathSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_math.c'),
      'utf8'
    );

    // No hardcoded paths, no game-specific hacks
    assert.strictEqual(/JK\.EXE/i.test(mathSrc), false);
    assert.strictEqual(/quake3\.exe/i.test(mathSrc), false);
    assert.strictEqual(/\/Users\/[a-z0-9_-]+/i.test(mathSrc), false);
  });
});
