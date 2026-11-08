'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suite, test, assert } = require('../harness/index.cjs');

const macNative = require('../../../electron/launcher/macNativeInstallerAndCodesign.cjs');
const supervisor = require('../../../electron/launcher/sessionAndProcessSupervisor.cjs');

function buildSyntheticPe32Buffer(byteLen = 4096) {
  const buf = Buffer.alloc(Math.max(byteLen, 512), 0);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(0x014c, 0x84);
  buf.writeUInt16LE(0x0002, 0x96);
  buf.writeUInt16LE(0x010b, 0x98);
  buf.writeUInt16LE(2, 0xdc);
  return buf;
}

suite('Tier 1 — Feature F16: Universal Chained Launchers & OpenGL Drawable State Preservation', () => {
  test({
    id: 'F16-01',
    feature: 'F16',
    tier: 1,
    description: 'Universal sibling bootstrapper discovery promotes validated PE <stem>.exe while confining to rootDir',
  }, () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-f16-'));
    try {
      const gameRoot = path.join(tmpRoot, 'SampleTitle');
      const binDir = path.join(gameRoot, 'System');
      fs.mkdirSync(binDir, { recursive: true });

      const mainExe = path.join(binDir, 'SampleEngineMain.exe');
      const stubExe = path.join(binDir, 'sampleengine.exe');
      fs.writeFileSync(mainExe, buildSyntheticPe32Buffer(32768));
      fs.writeFileSync(stubExe, buildSyntheticPe32Buffer(8192));

      assert.strictEqual(
        macNative.resolveSiblingLauncherStub(mainExe, gameRoot),
        stubExe,
        'Sibling bootstrapper stub in same directory must be selected'
      );

      // Normal words ending in "main" must never be misclassified as split binaries
      assert.strictEqual(macNative.extractSiblingLauncherStem('Domain.exe'), null);
      assert.strictEqual(macNative.extractSiblingLauncherStem('Remain.exe'), null);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test({
    id: 'F16-02',
    feature: 'F16',
    tier: 1,
    description: 'Wine argument normalization converts verified paths without mangling URIs, switches, or auth tokens',
  }, () => {
    assert.strictEqual(
      supervisor.normalizeWineArgumentBackslashes('https://cdn.example.org/patch/manifest.json'),
      'https://cdn.example.org/patch/manifest.json'
    );
    assert.strictEqual(
      supervisor.normalizeWineArgumentBackslashes('/nosound'),
      '/nosound'
    );
    const opaqueToken = 'QwErTyUiOpAsDfGhJkLzXcVbNm0123456789+/AbCd=';
    assert.strictEqual(
      supervisor.normalizeWineArgumentBackslashes(opaqueToken),
      opaqueToken
    );
    assert.strictEqual(
      supervisor.normalizeWineArgumentBackslashes('C:/Games/Engine/System/Launcher.exe'),
      'C:\\Games\\Engine\\System\\Launcher.exe'
    );
  });

  test({
    id: 'F16-03',
    feature: 'F16',
    tier: 1,
    description: 'display_scaler_dll.c intercepts ShellExecuteA/W & ShellExecuteExA/W for universal multi-hop process chaining',
  }, () => {
    const dllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    assert.ok(dllSrc.includes('hook_ShellExecuteExW'), 'Must define hook_ShellExecuteExW');
    assert.ok(dllSrc.includes('hook_ShellExecuteExA'), 'Must define hook_ShellExecuteExA');
    assert.ok(dllSrc.includes('hook_ShellExecuteW'), 'Must define hook_ShellExecuteW');
    assert.ok(dllSrc.includes('hook_ShellExecuteA'), 'Must define hook_ShellExecuteA');
    assert.ok(dllSrc.includes('ds_prefer_16bpp_ddraw'), 'Must isolate 16bpp preference to non-D3D8/9 DirectDraw');
  });

  test({
    id: 'F16-04',
    feature: 'F16',
    tier: 1,
    description: 'display_scaler_gl_gdi.c preserves GL_VIEWPORT, GL_SCISSOR_BOX, and GL_COLOR_CLEAR_VALUE across drawable attach & pillarbox clears',
  }, () => {
    const glSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_gl_gdi.c'),
      'utf8'
    );

    assert.ok(glSrc.includes('GL_VIEWPORT'), 'Must query and restore GL_VIEWPORT');
    assert.ok(glSrc.includes('GL_SCISSOR_BOX'), 'Must query and restore GL_SCISSOR_BOX');
    assert.ok(glSrc.includes('GL_COLOR_CLEAR_VALUE'), 'Must query and restore GL_COLOR_CLEAR_VALUE');
    assert.ok(glSrc.includes('last_w3d_vp'), 'Must recover WineD3D offscreen FBO viewport after lazy Cocoa drawable attach');
  });

  test({
    id: 'F16-05',
    feature: 'F16',
    tier: 1,
    description: 'Zero game-specific names, store IDs, or hardcoded host display dimensions in display scaler & launcher modules',
  }, () => {
    const filesToAudit = [
      'electron/helpers/display_scaler/display_scaler.h',
      'electron/helpers/display_scaler/display_scaler_internal.h',
      'electron/helpers/display_scaler/display_scaler_math.c',
      'electron/helpers/display_scaler/display_scaler_dll.c',
      'electron/helpers/display_scaler/display_scaler_window.c',
      'electron/helpers/display_scaler/display_scaler_gl_gdi.c',
      'electron/helpers/display_scaler/display_launcher.c',
    ];
    const hardcodedHostRes = /\b(1512|982|3024|1964)\b/;
    const piiRegex = /\/Users\/(?!runner|Shared)[a-zA-Z0-9_-]+\//;

    for (const rel of filesToAudit) {
      const abs = path.resolve(__dirname, '../../../', rel);
      const src = fs.readFileSync(abs, 'utf8');
      // Strip C comments before checking numeric literals so architectural doc examples never false-trigger
      const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.strictEqual(
        hardcodedHostRes.test(codeOnly),
        false,
        `Zero-hardcoded-host-resolution violation in ${rel}`
      );
      assert.strictEqual(
        piiRegex.test(src),
        false,
        `Zero-PII violation in ${rel}`
      );
    }
  });

  test({
    id: 'F16-06',
    feature: 'F16',
    tier: 1,
    description: 'OneLauncherGLHostChild omits WS_DISABLED so Win32/Wine WM_NCHITTEST -> HTTRANSPARENT delivers WM_MOUSEMOVE & WM_LBUTTONDOWN to hwnd_game',
  }, () => {
    const winSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );
    const dllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );
    const codeOnlyWin = winSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    assert.strictEqual(
      codeOnlyWin.includes('WS_DISABLED'),
      false,
      'OneLauncherGLHostChild must never set WS_DISABLED (which causes win32u window_from_point to return HTERROR -2 and drop mouse input)'
    );
    assert.ok(codeOnlyWin.includes('HTTRANSPARENT'), 'ds_gl_host_wndproc must return HTTRANSPARENT on WM_NCHITTEST');
    assert.ok(codeOnlyWin.includes('MA_NOACTIVATE'), 'ds_gl_host_wndproc must return MA_NOACTIVATE on WM_MOUSEACTIVATE');
    assert.ok(dllSrc.includes('hook_MapWindowPoints'), 'display_scaler_dll.c must virtualize MapWindowPoints');
    assert.ok(dllSrc.includes('hook_WindowFromPoint'), 'display_scaler_dll.c must virtualize WindowFromPoint');
  });

  test({
    id: 'F16-07',
    feature: 'F16',
    tier: 1,
    description: 'Pre-ChangeDisplaySettings SetWindowPos fullscreen promotion & transparent GWLP_WNDPROC chaining preserve full-monitor hit-testing and mouse coordinate remapping',
  }, () => {
    const winSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );
    const dllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    assert.ok(
      dllSrc.includes('ds_try_promote_fullscreen_resize_locked'),
      'hook_SetWindowPos and hook_MoveWindow must promote sub-panel fullscreen resizes before ChangeDisplaySettings so wineserver visible_rect never clamps'
    );
    assert.ok(
      dllSrc.includes('hook_GetWindowLongA') && dllSrc.includes('hook_GetWindowLongW'),
      'display_scaler_dll.c must hook GetWindowLongA/W to chain GWLP_WNDPROC transparently'
    );
    assert.ok(
      dllSrc.includes('ds_handle_get_window_long') && dllSrc.includes('GWLP_WNDPROC'),
      'SetWindowLong*/GetWindowLong* must keep ds_game_subclass_wndproc outermost across wined3d subclassing'
    );
    assert.ok(
      winSrc.includes('visible_resync_needed') && winSrc.includes('visible_resync_done'),
      'display_scaler_window.c must provide belt-and-suspenders visible_rect resynchronization if edge hit-test ever misses'
    );
  });

  test({
    id: 'F16-08',
    feature: 'F16',
    tier: 1,
    description: 'Wine D3DKMTEscape present_rect clamp clearance & suspended external WndProc recursion guard preserve full-monitor mouse hit-testing and centered fullscreen bounds',
  }, () => {
    const hdrSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_internal.h'),
      'utf8'
    );
    const winSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_window.c'),
      'utf8'
    );
    const dllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    assert.ok(
      hdrSrc.includes('DS_WINE_D3DKMT_ESCAPE_SET_PRESENT_RECT') && hdrSrc.includes('0x80000001u'),
      'display_scaler_internal.h must define DS_WINE_D3DKMT_ESCAPE_SET_PRESENT_RECT (0x80000001u)'
    );
    assert.ok(
      dllSrc.includes('ds_clear_wine_present_rect_on_hwnd') && dllSrc.includes('hook_D3DKMTEscape'),
      'display_scaler_dll.c must intercept D3DKMTEscape/NtGdiDdDDIEscape and clear Wine swapchain present_rect clamps on hwnd_game'
    );
    assert.ok(
      winSrc.includes('ds_clear_wine_present_rect_on_hwnd'),
      'display_scaler_window.c must clear Wine present_rect before applying fullscreen or scaled window presentation'
    );
    assert.ok(
      dllSrc.includes('ds_suspend_internal_depth') && winSrc.includes('ds_suspend_internal_depth'),
      'ds_game_subclass_wndproc must suspend tls_depth_idx before CallWindowProc so synchronous wined3d/game WndProc calls pass through fullscreen guards'
    );
  });
});
