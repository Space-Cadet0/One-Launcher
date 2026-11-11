import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, '..');

const buildXboxBridge = require('../scripts/build-xbox-bridge.cjs');
const buildDisplayScaler = require('../scripts/build-display-scaler.cjs');
const nativeOracle = require('./e2e_fullscreen/harness/native_oracle.cjs');

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

describe('Total Project Review — Wave 2A: Native C11 Display Scaler, macOS Helpers & XGR Runtime Bridge Remediation', () => {
  // --------------------------------------------------------------------------
  // 1. Deterministic PE32/PE64 & Universal Mach-O Binary Verification
  // --------------------------------------------------------------------------
  describe('1. Deterministic PE32/PE64 & Universal Mach-O Binary Verification', () => {
    it('verifies all 8 Xbox GDK Runtime / GameInput / AppNotify / WinLauncher PE32 & PE64 binaries, exports, markers, and manifests', () => {
      const verified = buildXboxBridge.verifyXboxBridgeDll();

      expect(verified.machine).toBe('0x8664');
      expect(verified.marker).toBe('OneLauncher.XGRBridge.v1');
      expect(verified.exports).toEqual([
        'DllCanUnloadNow',
        'InitializeApiImpl',
        'InitializeApiImplEx',
        'InitializeApiImplEx2',
        'QueryApiImpl',
        'UninitializeApiImpl',
        'XErrorReport',
      ]);

      expect(verified.xgrBridgeX86.machine).toBe('0x014c');
      expect(verified.xgrBridgeX86.marker).toBe('OneLauncher.XGRBridge.v1');
      expect(verified.xgrBridgeX86.exports).toEqual(verified.exports);

      expect(verified.gameInputBridge.machine).toBe('0x8664');
      expect(verified.gameInputBridge.marker).toBe('OneLauncher.GameInputBridge.v1');
      expect(verified.gameInputBridge.exports).toEqual(['DllCanUnloadNow', 'GameInputCreate']);

      expect(verified.gameInputBridgeX86.machine).toBe('0x014c');
      expect(verified.gameInputBridgeX86.marker).toBe('OneLauncher.GameInputBridge.v1');
      expect(verified.gameInputBridgeX86.exports).toEqual(['DllCanUnloadNow', 'GameInputCreate']);

      expect(verified.appNotifyBridge.machine).toBe('0x8664');
      expect(verified.appNotifyBridgeX86.machine).toBe('0x014c');
      expect(verified.appNotifyBridgeX86.exports).toEqual([
        'RegisterAppConstrainedChangeNotification',
        'RegisterAppStateChangeNotification',
        'UnregisterAppConstrainedChangeNotification',
        'UnregisterAppStateChangeNotification',
      ]);

      expect(verified.winXgrLauncher.machine).toBe('0x8664');
      expect(verified.winXgrLauncher.subsystem).toBe(2);
      expect(verified.winXgrLauncherX86.machine).toBe('0x014c');
      expect(verified.winXgrLauncherX86.subsystem).toBe(2);
    });

    it('verifies all 4 Display Scaler & Preloader Launcher PE32 & PE64 binaries (<120 KB, deterministic headers, exports, markers)', () => {
      const verified = buildDisplayScaler.verifyDisplayScalerBinaries();

      expect(buildDisplayScaler.MAX_BINARY_SIZE_BYTES).toBe(120 * 1024);

      expect(verified.scalerX86.machine).toBe('0x14c');
      expect(verified.scalerX86.sizeBytes).toBeLessThan(120 * 1024);
      expect(verified.scalerX86.exportedNames).toEqual([
        'OneLauncherDisplayScalerGetVersion',
        'OneLauncherDisplayScalerTriggerScan',
      ]);

      expect(verified.scalerX64.machine).toBe('0x8664');
      expect(verified.scalerX64.sizeBytes).toBeLessThan(120 * 1024);
      expect(verified.scalerX64.exportedNames).toEqual([
        'OneLauncherDisplayScalerGetVersion',
        'OneLauncherDisplayScalerTriggerScan',
      ]);

      expect(verified.launcherX86.machine).toBe('0x14c');
      expect(verified.launcherX86.subsystem).toBe(2);
      expect(verified.launcherX86.sizeBytes).toBeLessThan(120 * 1024);

      expect(verified.launcherX64.machine).toBe('0x8664');
      expect(verified.launcherX64.subsystem).toBe(2);
      expect(verified.launcherX64.sizeBytes).toBeLessThan(120 * 1024);
    });

    it('enforces -mstackrealign on x86 targets and dead-section pruning (-ffunction-sections, -fdata-sections, -Wl,--gc-sections) across build scripts', () => {
      const xboxBuildSrc = readRepoFile('scripts/build-xbox-bridge.cjs');
      const scalerBuildSrc = readRepoFile('scripts/build-display-scaler.cjs');

      for (const src of [xboxBuildSrc, scalerBuildSrc]) {
        expect(src).toContain('-mstackrealign');
        expect(src).toContain('-fno-unwind-tables');
        expect(src).toContain('-fno-asynchronous-unwind-tables');
        expect(src).toContain('-ffunction-sections');
        expect(src).toContain('-fdata-sections');
        expect(src).toContain('-Wl,--gc-sections');
      }
    });

    it('verifies universal (arm64 + x86_64) signed macOS Cocoa & Metal helper dylibs on darwin', () => {
      const metalSrc = path.join(REPO_ROOT, 'electron', 'helpers', 'one_metal_preload.c');
      const coopSrc = path.join(REPO_ROOT, 'electron', 'helpers', 'one_coop_activate.c');
      expect(fs.existsSync(metalSrc)).toBe(true);
      expect(fs.existsSync(coopSrc)).toBe(true);

      if (process.platform === 'darwin') {
        const metalDylib = path.join(REPO_ROOT, 'electron', 'helpers', 'libone_metal_preload.dylib');
        const coopDylib = path.join(REPO_ROOT, 'electron', 'helpers', 'libone_coop_activate.dylib');

        expect(fs.existsSync(metalDylib)).toBe(true);
        expect(fs.existsSync(coopDylib)).toBe(true);
        expect(fs.statSync(metalDylib).size).toBeGreaterThan(16 * 1024);
        expect(fs.statSync(coopDylib).size).toBeGreaterThan(16 * 1024);

        for (const dylib of [metalDylib, coopDylib]) {
          const archs = execFileSync('lipo', ['-archs', dylib], { encoding: 'utf8' }).trim();
          expect(archs).toContain('arm64');
          expect(archs).toContain('x86_64');
          const cs = spawnSync('codesign', ['--verify', '--verbose=2', dylib], { encoding: 'utf8' });
          expect(cs.status).toBe(0);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Wave 1D Display Scaler Geometry, OpenGL/GDI, Multi-Hop & macOS Helpers
  // --------------------------------------------------------------------------
  describe('2. Wave 1D Display Scaler Geometry, OpenGL/GDI, Multi-Hop & macOS Helpers', () => {
    it('rounds letterboxed dst_h to even and guarantees exact pixel-center cursor round-trip without -1px/frame ceiling spin', () => {
      const vp900p = nativeOracle.invokeNativeViewport(3024, 1964, 0, 1600, 900, 'preserve');
      expect(vp900p).toBeTruthy();
      expect(vp900p.dstW).toBe(3024);
      expect(vp900p.dstH).toBe(1700);
      expect(vp900p.dstH % 2).toBe(0);

      // 1,000-frame center warp at (800, 450) in 1600x900 on 3024x1964 must produce zero drift
      const drift900p = nativeOracle.invokeNativeWarpDrift(1000, 3024, 1964, 0, 1600, 900);
      expect(drift900p).toEqual({ iterations: 1000, driftX: 0, driftY: 0 });

      const drift480p = nativeOracle.invokeNativeWarpDrift(1000, 3024, 1964, 0, 640, 480);
      expect(drift480p).toEqual({ iterations: 1000, driftX: 0, driftY: 0 });

      const mathSrc = readRepoFile('electron/helpers/display_scaler/display_scaler_math.c');
      expect(mathSrc).toContain('(((cvx * 2LL) + 1LL) * (int64_t)dst_w) / (2LL * (int64_t)virt_w)');
      expect(mathSrc).toContain('(((cvy * 2LL) + 1LL) * (int64_t)dst_h) / (2LL * (int64_t)virt_h)');
    }, 60_000);

    it('guards GL_COLOR_WRITEMASK + GL_FRAMEBUFFER_SRGB, masks internal FBO bindings, and implements two-pass zero-shader Sharp-Bilinear', () => {
      const glGdiSrc = readRepoFile('electron/helpers/display_scaler/display_scaler_gl_gdi.c');
      const internalHdr = readRepoFile('electron/helpers/display_scaler/display_scaler_internal.h');

      expect(glGdiSrc).toContain('GL_COLOR_WRITEMASK');
      expect(glGdiSrc).toContain('glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE)');
      expect(glGdiSrc).toContain('GL_FRAMEBUFFER_SRGB');
      expect(internalHdr).toContain('0x8DB9');
      expect(glGdiSrc).toContain('hook_glDeleteFramebuffers');
      expect(glGdiSrc).toContain('hook_glGetIntegerv');
      expect(glGdiSrc).toContain('GL_RENDERBUFFER_BINDING');
      expect(glGdiSrc).toContain('ds_gl_ensure_sharp_fbo');
      expect(glGdiSrc).toContain('DS_FILTER_SHARP');
      // Watertight GDI edge rasterization & banded SetDIBitsToDevice -> StretchDIBits
      expect(glGdiSrc).toContain('StretchDIBits');
      expect(glGdiSrc).toContain('GetStretchBltMode');
      expect(glGdiSrc).toContain('GetDCEx');
    });

    it('implements modern Metal/DXMT/Vulkan passthrough, active_session.ini discovery, custom env merging, .bat/.cmd routing, and DllMain loader-lock safety', () => {
      const dllSrc = readRepoFile('electron/helpers/display_scaler/display_scaler_dll.c');
      const winSrc = readRepoFile('electron/helpers/display_scaler/display_scaler_window.c');
      const launcherSrc = readRepoFile('electron/helpers/display_scaler/display_launcher.c');

      for (const modName of [
        'dxgi.dll',
        'd3d10.dll',
        'd3d11.dll',
        'd3d12.dll',
        'vulkan-1.dll',
        'winevulkan.dll',
        'd3dmetal.dll',
        'winemetal.dll',
      ]) {
        expect(dllSrc).toContain(`L"${modName}"`);
      }

      expect(dllSrc).toContain('modern_swapchain_passthrough');
      expect(dllSrc).toContain('active_session.ini');
      expect(dllSrc).toContain('InitOnceInitialize(&g_ds.watcher_once)');
      expect(winSrc).toContain('InitOnceExecuteOnce(&g_ds.watcher_once');
      expect(dllSrc).toContain('QueryFullProcessImageNameW');
      expect(dllSrc).toContain('ComSpec');
      expect(dllSrc).toContain('GetClipCursor');
      expect(dllSrc).toContain('GetDeviceCaps');
      expect(dllSrc).toContain('GetMonitorInfoW');
      expect(dllSrc).toContain('GetMessagePos');
      expect(dllSrc).toContain('GetRawInputData');
      expect(dllSrc).toContain('MOUSE_MOVE_ABSOLUTE');
      expect(dllSrc).toContain('RIDEV_NOLEGACY');
      expect(dllSrc).toContain('SM_CXFULLSCREEN');
      expect(dllSrc).toContain('SM_CYFULLSCREEN');

      expect(winSrc).toContain('WM_MOUSEWHEEL');
      expect(winSrc).toContain('WM_CONTEXTMENU');
      expect(winSrc).toContain('WM_NCHITTEST');
      expect(winSrc).toContain('WM_DISPLAYCHANGE');
      expect(winSrc).toContain('SetMenu');

      // When --tid != 0 on a CREATE_SUSPENDED child, display_launcher.c must NEVER fall through to CreateRemoteThread
      expect(launcherSrc).toContain('if (tid != 0)');
      expect(launcherSrc).toContain('ExitProcess(DS_LAUNCH_ERR_APC_INJECT)');
    });

    it('protects macOS focus from stealing Cmd+Tab apps in one_coop_activate.c and skips Wine wrappers + Bluetooth 5ms clamping in one_metal_preload.c', () => {
      const coopSrc = readRepoFile('electron/helpers/one_coop_activate.c');
      const metalSrc = readRepoFile('electron/helpers/one_metal_preload.c');

      expect(coopSrc).toContain('frontmostApplication');
      expect(coopSrc).toContain('steamwebhelper.exe');
      expect(coopSrc).toContain('epicgameslauncher.exe');
      expect(coopSrc).toContain('galaxyclient.exe');
      expect(coopSrc).toContain('eadesktop.exe');
      expect(coopSrc).toContain('upc.exe');

      expect(metalSrc).toContain('wine64-preloader');
      expect(metalSrc).toContain('wine-preloader');
      expect(metalSrc).toContain('one_display_launcher_');
      expect(metalSrc).toContain('kAudioDevicePropertyTransportType');
      expect(metalSrc).toContain('kAudioDeviceTransportTypeBluetooth');
      expect(metalSrc).toContain('kAudioDeviceTransportTypeAirPlay');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Wave 1C Native Win32 C11 XGR Runtime Bridge & GameInput Remediation
  // --------------------------------------------------------------------------
  describe('3. Wave 1C Native Win32 C11 XGR Runtime Bridge & GameInput Remediation', () => {
    it('fixes XTaskQueue worker self-join/UAF, async PlayFab pre-uninit upload chaining, and XUserHandle retention', () => {
      const xthSrc = readRepoFile('electron/helpers/xgr_bridge/xthreading.c');
      const pfSrc = readRepoFile('electron/helpers/xgr_bridge/xgr_playfab_shim.c');

      expect(xthSrc).toContain('owner_refs');
      expect(xthSrc).toContain('worker_tid');
      expect(xthSrc).toContain('resolve_queue(q, &temp_ref)');
      expect(xthSrc).toContain('xgr_threading_process_detach_cleanup');

      expect(pfSrc).toContain('PfPreUninitCtx');
      expect(pfSrc).toContain('pf_pre_uninit_upload_done_cb');
      expect(pfSrc).toContain('xgr_user_duplicate');
      expect(pfSrc).not.toContain('WaitForSingleObject(done_ev');
    });

    it('splits GameInput v0 5-arg Guide vs 6-arg SystemButton vtables by IID, raises callback slots to 256 without overwriting slot 0, and pins DLL lifetime', () => {
      const giSrc = readRepoFile('electron/helpers/xgr_bridge/gameinput_bridge.c');

      expect(giSrc).toContain('g_mgr_v0_sys_vtbl');
      expect(giSrc).toContain('gi_mgr_v0_RegisterGuideButtonCallback');
      expect(giSrc).toContain('gi_mgr_v0_RegisterSystemButtonCallback');
      expect(giSrc).toMatch(/GI_MAX_CALLBACKS\s+256/);
      expect(giSrc).toContain('GET_MODULE_HANDLE_EX_FLAG_PIN');
      expect(giSrc).toContain('g_worker_threads_spawned');
      expect(giSrc).toContain('timeout_us');
    });

    it('wires DLC storeId <-> packageIdentifier across XPackage/XStore, hardens XGameSaveUpdate SRWLOCK + atomic submit, pins XCurl IAT hooks, and parses JSON depth-aware', () => {
      const xpkgSrc = readRepoFile('electron/helpers/xgr_bridge/xpackage.c');
      const xstoreSrc = readRepoFile('electron/helpers/xgr_bridge/xstore.c');
      const xgsSrc = readRepoFile('electron/helpers/xgr_bridge/xgamesave.c');
      const mainSrc = readRepoFile('electron/helpers/xgr_bridge/main.c');
      const xcurlSrc = readRepoFile('electron/helpers/xgr_bridge/xgr_xcurl_shim.c');
      const rpcSrc = readRepoFile('electron/helpers/xgr_bridge/xgr_rpc.c');
      const xmlSrc = readRepoFile('electron/helpers/xgr_bridge/xgr_xml_pfn.c');

      expect(xpkgSrc).toContain('xgr_package_find_identifier_by_store_id');
      expect(xpkgSrc).toContain('xgr_package_find_store_id_by_identifier');
      expect(xstoreSrc).toContain('xgr_package_find_identifier_by_store_id(storeId, pkgId, size)');
      expect(xstoreSrc).toContain('xgr_package_find_store_id_by_identifier(pkgId, store_id, sizeof(store_id))');

      expect(xgsSrc).toContain('InitializeSRWLock(&u->lock)');
      expect(xgsSrc).toContain('E_GS_HANDLE_EXPIRED');
      expect(xgsSrc).toContain('SIZE_MAX - w->len');
      expect(xgsSrc).toContain('xgr_ensure_session_metadata_loaded()');

      expect(mainSrc).toContain('g_runtime_lifecycle_lock');
      expect(xcurlSrc).toContain('GET_MODULE_HANDLE_EX_FLAG_PIN');
      expect(rpcSrc).toContain('if (depth == 1 && expect_key)');
      expect(xmlSrc).toContain('\\"packageFamilyName\\":');
    });

    it('passes both native Clang C11 ASan + UBSan sanitizer harnesses with zero leaks and zero UB', () => {
      const dsRes = nativeOracle.runNativeMathAsan();
      expect(dsRes.status).toBe(0);
      if (process.platform !== 'win32') {
        expect(dsRes.stdout).toContain('[DS-ASAN-PASS]');
      }

      const xgrRes = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'test-xbox-bridge-asan.cjs')],
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );
      expect(xgrRes.status).toBe(0);
      if (process.platform !== 'win32') {
        expect(xgrRes.stdout).toContain('[xgr_bridge_asan_test] PASS');
        expect(xgrRes.stdout).toContain('[xgr_wave2a_asan_test] PASS');
      }
    }, 60000);
  });
});
