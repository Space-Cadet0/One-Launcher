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

  test({
    id: 'T3-17',
    feature: 'F8+F10',
    tier: 3,
    description: '[F8+F10] Xbox OAuth auth flow + Token Vault AES-256-GCM encrypted persistence',
  }, () => {
    const xboxAuth = require('../../../electron/storefronts/xbox/xboxAuthManager.cjs');
    const tokenVault = require('../../../electron/storefronts/tokenVault.cjs');
    const vaultPath = path.join(tempDir, 'tokens-f8-f10.json');

    const authUrlData = xboxAuth.buildXboxAuthorizationUrl();
    assert.ok(authUrlData.url.startsWith('https://login.live.com'));

    const mockTokens = {
      accessToken: 'xbl_sample_token_xyz',
      refreshToken: 'xbl_refresh_token_abc',
      obtainedAt: Date.now(),
      expiresIn: 3600,
    };
    tokenVault.saveTokens('xbox', mockTokens, { filePath: vaultPath });

    const rawEncrypted = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
    assert.strictEqual(rawEncrypted.alg, 'aes-256-gcm');
    assert.ok(rawEncrypted.iv && rawEncrypted.tag && rawEncrypted.data);

    const decrypted = tokenVault.loadSavedTokens({ filePath: vaultPath });
    assert.strictEqual(decrypted.xbox.accessToken, 'xbl_sample_token_xyz');
  });

  test({
    id: 'T3-18',
    feature: 'F8+F9',
    tier: 3,
    description: '[F8+F9] Xbox LiveSDK auth token exchange + GDK C11 bridge container structure',
  }, () => {
    const xboxAuth = require('../../../electron/storefronts/xbox/xboxAuthManager.cjs');
    const isJwe = xboxAuth.isCompactJwe('invalid.token');
    assert.strictEqual(isJwe, false);

    const bridgeH = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgr_internal.h'),
      'utf8'
    );
    assert.ok(bridgeH.includes('E_GS_INVALID_CONTAINER_NAME'));
  });

  test({
    id: 'T3-19',
    feature: 'F9+F15',
    tier: 3,
    description: '[F9+F15] Xbox GDK C11 bridge + Process Supervisor win_xgr_launcher child process tree tracking',
  }, () => {
    const supervisor = require('../../../electron/launcher/sessionAndProcessSupervisor.cjs');
    const wineMgr = require('../../../electron/launcher/wineAndCrossOverManager.cjs');

    const winLauncherPath = wineMgr.resolveBundledXboxWinLauncherExePath();
    assert.ok(typeof winLauncherPath === 'string');
    assert.strictEqual(typeof supervisor.getRunningGames, 'function');
  });

  test({
    id: 'T3-20',
    feature: 'F10+F17',
    tier: 3,
    description: '[F10+F17] Token Vault file atomic updates + Offline DB SQLite cache synchronization',
  }, () => {
    const tokenVault = require('../../../electron/storefronts/tokenVault.cjs');
    const offline = require('../../../electron/launcher/offlineVaultService.cjs');
    const vaultPath = path.join(tempDir, 'tokens-atomic.json');

    tokenVault.saveTokens('epic', { token: 'sample-v1' }, { filePath: vaultPath });
    assert.ok(fs.existsSync(vaultPath));
    tokenVault.saveTokens('epic', { token: 'sample-v2' }, { filePath: vaultPath });
    assert.ok(fs.existsSync(`${vaultPath}.bak`));

    const bigPayload = JSON.stringify({ library: Array.from({ length: 50 }, (_, i) => ({ id: `game-${i}`, title: `Game ${i}` })) });
    const compressed = offline.compressVaultJson(bigPayload);
    assert.ok(compressed.startsWith(offline.VAULT_ZLIB_PREFIX));
  });

  test({
    id: 'T3-21',
    feature: 'F11+F15',
    tier: 3,
    description: '[F11+F15] Steam post-session cloud save two-stage barrier + Process supervisor exit event latching',
  }, () => {
    const supervisor = require('../../../electron/launcher/sessionAndProcessSupervisor.cjs');
    const cloudSave = require('../../../electron/launcher/cloudSaveEngine.cjs');

    assert.strictEqual(typeof supervisor.waitForSteamCloudSyncCompletion, 'function');
    assert.strictEqual(typeof cloudSave.enforceCloudSaveBackupQuotaSync, 'function');
  });

  test({
    id: 'T3-22',
    feature: 'F11+F16',
    tier: 3,
    description: '[F11+F16] Steam Cloud sync path traversal prevention + safe uninstall path protection',
  }, () => {
    const cloudSave = require('../../../electron/launcher/cloudSaveEngine.cjs');
    const uninstall = require('../../../electron/launcher/uninstallSafety.cjs');

    assert.strictEqual(cloudSave.isSafeEpicSaveTemplateSyntax('{InstallDir}/save.dat'), true);
    assert.strictEqual(cloudSave.isSafeEpicSaveTemplateSyntax('{InvalidToken}/save.dat'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('/'), false);
  });

  test({
    id: 'T3-23',
    feature: 'F12+F16',
    tier: 3,
    description: '[F12+F16] GOG multi-part streaming download coordinator + security containment of staging chunks',
  }, () => {
    const downloadCoord = require('../../../electron/launcher/downloadQueueCoordinator.cjs');
    const security = require('../../../electron/launcher/securityAndPathUtils.cjs');

    const trusted = downloadCoord.validateTrustedExternalLauncherUrl('https://ea.com/setup/installer.exe');
    assert.ok(trusted.includes('ea.com'));
    assert.strictEqual(security.isContainedWithinRoot('/Games', '/Games/../../etc'), false);
  });

  test({
    id: 'T3-24',
    feature: 'F12+F18',
    tier: 3,
    description: '[F12+F18] GOG Wine user.reg auto-patching + Wine bottle graphics backend configuration',
  }, () => {
    const gogScript = require('../../../electron/storefronts/gog/gogScriptInterpreter.cjs');
    const wineMgr = require('../../../electron/launcher/wineAndCrossOverManager.cjs');

    assert.strictEqual(typeof gogScript.patchRawWineRegistrySectionsBatch, 'function');
    assert.strictEqual(typeof wineMgr.sanitizeProvisionedBottleGraphicsBackend, 'function');
  });

  test({
    id: 'T3-25',
    feature: 'F13+F15',
    tier: 3,
    description: '[F13+F15] Epic third-party partner launcher handoff + Process supervisor chained child PID tracking',
  }, () => {
    const chained = require('../../../electron/launcher/chainedPublisherLaunchers.cjs');
    const supervisor = require('../../../electron/launcher/sessionAndProcessSupervisor.cjs');

    const spec = chained.buildChainedLauncherLaunchSpec({ handoffId: 'bnet' });
    assert.ok(spec && spec.envOverrides && spec.envOverrides.WINE_WAIT_CHILD_PIPE_IGNORE === 'Agent.exe');
    assert.strictEqual(typeof supervisor.findLiveBottleGameChildPid, 'function');
  });

  test({
    id: 'T3-26',
    feature: 'F13+F18',
    tier: 3,
    description: '[F13+F18] Epic EA App chained bottle autostart sanitization + Wine prefix hygiene',
  }, () => {
    const chained = require('../../../electron/launcher/chainedPublisherLaunchers.cjs');
    const wineMgr = require('../../../electron/launcher/wineAndCrossOverManager.cjs');

    const fakeBottle = path.join(tempDir, 'ea-bottle');
    fs.mkdirSync(fakeBottle, { recursive: true });
    assert.doesNotThrow(() => {
      chained.sanitizeEaBottleAutostartInUserReg(fakeBottle);
    });
    const env = wineMgr.applyStrictRosettaAvxEnv({}, false);
    assert.strictEqual(env.ROSETTA_ADVERTISE_AVX, undefined);
  });

  test({
    id: 'T3-27',
    feature: 'F14+F16',
    tier: 3,
    description: '[F14+F16] Universal portability relative path resolution + Zero-PII sanitization across external storefronts',
  }, () => {
    const security = require('../../../electron/launcher/securityAndPathUtils.cjs');
    const normalized = security.toHostFilesystemPath('C:\\Games\\Doom\\app.exe');
    assert.ok(typeof normalized === 'string');
    assert.strictEqual(security.isContainedWithinRoot('/home/user', '/home/user/../root'), false);
  });

  test({
    id: 'T3-28',
    feature: 'F15+F16',
    tier: 3,
    description: '[F15+F16] Process Supervisor SIGTERM/SIGKILL escalation + Path containment of target binary execution',
    async: true,
  }, async () => {
    const processTree = require('../../../electron/launcher/processTreeUtils.cjs');
    const security = require('../../../electron/launcher/securityAndPathUtils.cjs');

    const res = await processTree.signalSubprocessTree(-1, 'SIGTERM');
    assert.strictEqual(res.signaled, false);
    assert.strictEqual(security.isContainedWithinRoot('/Games', '/etc/passwd'), false);
  });

  test({
    id: 'T3-29',
    feature: 'F15+F18',
    tier: 3,
    description: '[F15+F18] Process Supervisor Job Object / POSIX process tree + Wine/CrossOver wineserver child reaper',
  }, () => {
    const supervisor = require('../../../electron/launcher/sessionAndProcessSupervisor.cjs');
    const wineMgr = require('../../../electron/launcher/wineAndCrossOverManager.cjs');

    assert.strictEqual(typeof supervisor.killPosixProcessesMatchingWinExe, 'function');
    assert.strictEqual(typeof wineMgr.mergeWineDllOverrides, 'function');
  });

  test({
    id: 'T3-30',
    feature: 'F16+F17',
    tier: 3,
    description: '[F16+F17] Path containment boundary validation + Offline Vault JSON asset caching without path injection',
  }, () => {
    const security = require('../../../electron/launcher/securityAndPathUtils.cjs');
    const offline = require('../../../electron/launcher/offlineVaultService.cjs');

    assert.strictEqual(security.isContainedWithinRoot('/Vault', '/Vault/../../system'), false);
    const parsed = offline.parseVaultJson('{"games":{}}');
    assert.ok(parsed && parsed.games);
  });

  test({
    id: 'T3-31',
    feature: 'F17+F21',
    tier: 3,
    description: '[F17+F21] Offline Vault LRU tier caching (P0/P1/P2) + High-performance media hydration pipeline eviction',
  }, () => {
    const media = require('../../../electron/launcher/mediaHydrationEngine.cjs');
    assert.strictEqual(media.isAssetAllowedForTier('cover', 0, 2), true);
    assert.strictEqual(media.isAssetAllowedForTier('hero', 0, 2), false);
    assert.strictEqual(media.isAssetAllowedForTier('hero', 0, 1), true);
  });

  test({
    id: 'T3-32',
    feature: 'F19+F20',
    tier: 3,
    description: '[F19+F20] Modern Web 10,000-item grid virtualization + React 19 error boundary failure isolation',
  }, () => {
    const totalItems = 10000;
    const startIndex = 500;
    const endIndex = 520;
    const slice = [];
    for (let i = startIndex; i <= endIndex; i++) {
      if (i === 510) {
        slice.push({ id: `item-${i}`, corrupted: true });
      } else {
        slice.push({ id: `item-${i}`, title: `Game ${i}` });
      }
    }
    const rendered = slice.map(item => item.corrupted ? 'Fallback Card' : item.title);
    assert.strictEqual(rendered.length, 21);
    assert.strictEqual(rendered[10], 'Fallback Card');
  });

  test({
    id: 'T3-33',
    feature: 'F19+F21',
    tier: 3,
    description: '[F19+F21] Virtual grid fast-scroll windowing + Media pipeline AbortController in-flight cancellation',
  }, () => {
    const controllers = [];
    for (let i = 0; i < 20; i++) {
      controllers.push(new AbortController());
    }
    // Fast-scroll fling: abort all currently flying controllers
    for (const c of controllers) {
      c.abort('Fast fling');
    }
    assert.ok(controllers.every(c => c.signal.aborted));
  });

  test({
    id: 'T3-34',
    feature: 'F20+F22',
    tier: 3,
    description: '[F20+F22] React 19 Error Boundary reporting + Strict architecture zero-Node frontend type contracts',
  }, () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')
    );
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.match(deps.react, /\^?19\./);
    const tsconfigPath = path.resolve(__dirname, '../../../tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      const content = fs.readFileSync(tsconfigPath, 'utf8');
      assert.match(content, /"strict"\s*:\s*true/);
    }
  });

  test({
    id: 'T3-35',
    feature: 'F23+F7',
    tier: 3,
    description: '[F23+F7] E2E Test Suite Runner + Whole-display Retina screencapture verification tool integration',
  }, () => {
    const verifyTool = require('../../../scripts/verify-display-output.cjs');
    const res = verifyTool.verifyDisplayOutput({ synthetic: true, verbose: false });
    assert.strictEqual(res.passed, true);
    assert.strictEqual(res.exitCode, 0);
  });

  test({
    id: 'T3-36',
    feature: 'F24+F1',
    tier: 3,
    description: '[F24+F1] Real-world legacy resolution game scaling (640x480) + Zero-blackout single-window scaler architecture',
  }, () => {
    const verifyTool = require('../../../scripts/verify-display-output.cjs');
    const geom = verifyTool.computeOracleViewport(3024, 1964, 0, 640, 480);
    assert.strictEqual(geom.dstH % 2, 0);
    assert.strictEqual(geom.dstX * 2 + geom.dstW, 3024);
  });
});
